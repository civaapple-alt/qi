import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { InMemoryEventStore, applySessionEvent } from "@civaapple/qi-agent/kernel";
import { TurnLoop } from "@civaapple/qi-agent/loop";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { parseSessionEvent } from "@civaapple/qi-protocol";
import { FileArtifactStore, ToolRegistry } from "@civaapple/qi-node/tools";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function event(sequence, data) {
  return {
    schemaVersion: 1,
    eventId: `evt_image_${sequence}`,
    sessionId: "ses_image_protocol",
    sequence,
    occurredAt: `2026-07-30T00:00:0${sequence}.000Z`,
    actor: sequence === 1 ? { kind: "runtime", id: "test" } : { kind: "user", id: "user" },
    type: sequence === 1 ? "session.created" : "run.triggered",
    data,
  };
}

test("old and image run.triggered events parse and replay without binary payloads", () => {
  let view = applySessionEvent(undefined, parseSessionEvent(event(1, {})));
  view = applySessionEvent(view, parseSessionEvent(event(2, {
    runId: "run_image_protocol",
    trigger: "user",
    input: "look [image #1]",
    content: [
      { type: "text", text: "look " },
      {
        type: "image",
        source: "clipboard",
        originalArtifactRef: `artifact://${"a".repeat(64)}`,
        preparedArtifactRef: `artifact://${"b".repeat(64)}`,
        originalMediaType: "image/png",
        mediaType: "image/jpeg",
        originalByteLength: 100,
        byteLength: 80,
        originalWidth: 1200,
        originalHeight: 800,
        width: 1000,
        height: 667,
        downsampled: true,
        formatChanged: true,
        orientationApplied: false,
      },
    ],
  })));
  assert.equal(view.runs.run_image_protocol.content[1].preparedArtifactRef, `artifact://${"b".repeat(64)}`);
  assert.equal(JSON.stringify(view).includes("base64"), false);

  let legacy = applySessionEvent(undefined, parseSessionEvent(event(1, {})));
  legacy = applySessionEvent(legacy, parseSessionEvent({
    ...event(2, { runId: "run_legacy_image", trigger: "user", input: "text only" }),
    eventId: "evt_legacy_image",
  }));
  assert.equal(legacy.runs.run_legacy_image.input, "text only");
  assert.equal(legacy.runs.run_legacy_image.content, undefined);
});

test("TurnLoop materializes image Artifacts only at provider boundary and degrades missing history", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-image-loop-"));
  const artifactRoot = join(root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  try {
    const artifactStore = new FileArtifactStore(artifactRoot);
    const artifact = await artifactStore.put(png, "image/png");
    const content = [
      { type: "text", text: "Inspect " },
      {
        type: "image",
        source: "clipboard",
        originalArtifactRef: artifact.ref,
        preparedArtifactRef: artifact.ref,
        originalMediaType: "image/png",
        mediaType: "image/png",
        originalByteLength: png.byteLength,
        byteLength: png.byteLength,
        originalWidth: 1,
        originalHeight: 1,
        width: 1,
        height: 1,
        downsampled: false,
        formatChanged: false,
        orientationApplied: false,
      },
    ];
    const model = new ScriptedModelPort([
      [{ type: "text.delta", delta: "first" }, { type: "completed", finishReason: "stop" }],
      [{ type: "text.delta", delta: "second" }, { type: "completed", finishReason: "stop" }],
    ], {
      input: new Set(["text", "image"]),
      output: new Set(["text"]),
      contextTokens: 32_000,
      parallelActions: false,
      promptCache: false,
    });
    const eventStore = new InMemoryEventStore();
    const loop = new TurnLoop({
      eventStore,
      modelPort: model,
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
    });
    const base = {
      sessionId: "ses_image_loop",
      subject: "agent",
      model: { provider: "test", model: "vision" },
      contextBlocks: [],
      contextBudgetTokens: 8_000,
      historyBudgetTokens: 4_000,
      maxSteps: 1,
      workspaceRoot: root,
      artifactStore,
    };
    await loop.run({ ...base, input: "Inspect [image #1]", content });
    assert.equal(model.requests[0].messages.at(-1).content.some((part) =>
      part.type === "image" && part.uri.startsWith("data:image/png;base64,")
    ), true);
    const storedEvents = eventStore.read("ses_image_loop").events;
    assert.equal(JSON.stringify(storedEvents).includes("base64"), false);
    assert.equal(storedEvents.find((item) => item.type === "run.triggered").data.content[1].preparedArtifactRef, artifact.ref);

    const digest = artifact.ref.slice("artifact://".length);
    await rm(join(artifactRoot, digest.slice(0, 2), digest));
    await loop.run({ ...base, input: "Continue" });
    assert.equal(model.requests[1].messages.some((message) =>
      message.content.some((part) => part.type === "text" && part.text.includes("[Image unavailable:"))
    ), true);
    assert.equal(model.requests[1].messages.some((message) =>
      message.content.some((part) => part.type === "artifact")
    ), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TurnLoop rejects image input before provider I/O when the model is text-only", async () => {
  const model = new ScriptedModelPort([], {
    input: new Set(["text"]),
    output: new Set(["text"]),
    contextTokens: 8_000,
    parallelActions: false,
    promptCache: false,
  });
  const store = new InMemoryEventStore();
  await assert.rejects(
    new TurnLoop({
      eventStore: store,
      modelPort: model,
      toolRegistry: new ToolRegistry(new InMemoryCapabilityBroker()),
    }).run({
      sessionId: "ses_image_denied",
      subject: "agent",
      input: "[image #1]",
      content: [{
        type: "image",
        source: "clipboard",
        originalArtifactRef: `artifact://${"a".repeat(64)}`,
        preparedArtifactRef: `artifact://${"a".repeat(64)}`,
        originalMediaType: "image/png",
        mediaType: "image/png",
        originalByteLength: 1,
        byteLength: 1,
        originalWidth: 1,
        originalHeight: 1,
        width: 1,
        height: 1,
        downsampled: false,
        formatChanged: false,
        orientationApplied: false,
      }],
      model: { provider: "test", model: "text" },
      contextBlocks: [],
      contextBudgetTokens: 4_000,
      maxSteps: 1,
      workspaceRoot: ".",
      artifactStore: { put() {}, get() {} },
    }),
    /does not support image input/,
  );
  assert.equal(model.requests.length, 0);
  assert.equal(store.read("ses_image_denied").events.length, 0);
});
