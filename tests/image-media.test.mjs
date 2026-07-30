import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { FileArtifactStore } from "@civaapple/qi-node/tools";
import { ToolRegistry } from "@civaapple/qi-node/tools";
import {
  ImageIngestService,
  createReadImageTool,
  detectImageUrlCandidates,
  prepareImageBytes,
} from "@civaapple/qi-node/media";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("small valid images remain byte-identical and use content-addressed Artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-image-"));
  try {
    const store = new FileArtifactStore(root);
    const image = await new ImageIngestService({ artifactStore: store }).ingestBytes({
      bytes: onePixelPng,
      source: "clipboard",
      declaredMediaType: "image/png",
    });
    assert.equal(image.originalArtifactRef, image.preparedArtifactRef);
    assert.equal(image.originalByteLength, onePixelPng.byteLength);
    assert.equal(image.byteLength, onePixelPng.byteLength);
    assert.equal(image.downsampled, false);
    assert.equal(image.formatChanged, false);
    assert.deepEqual(Buffer.from((await store.get(image.preparedArtifactRef)).content), onePixelPng);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_image is authority-checked and restricted to current Session originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-read-image-"));
  try {
    const store = new FileArtifactStore(root);
    const attached = await new ImageIngestService({ artifactStore: store }).ingestBytes({
      bytes: onePixelPng,
      source: "clipboard",
      declaredMediaType: "image/png",
    });
    const broker = new InMemoryCapabilityBroker();
    broker.grant({
      leaseId: "lea_read_image_test",
      subject: "agent",
      tools: ["read_image"],
      effects: ["read"],
      resources: ["artifact:**"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const registry = new ToolRegistry(broker);
    registry.register("read_image", createReadImageTool({
      getAllowedOriginalRefs: (sessionId) =>
        sessionId === "ses_image_tool" ? new Set([attached.originalArtifactRef]) : new Set(),
    }));
    const identity = registry.catalog().find((tool) => tool.name === "read_image").identity;
    const context = {
      sessionId: "ses_image_tool",
      runId: "run_image_tool",
      stepId: "stp_image_tool",
      actionId: "act_image_tool",
      subject: "agent",
      workspaceRoot: root,
      artifactStore: store,
    };
    const settlement = await registry.execute(
      "read_image",
      identity,
      { artifactRef: attached.originalArtifactRef },
      context,
    );
    assert.equal(settlement.modelOutput[1].type, "artifact");
    assert.match(settlement.modelOutput[1].ref, /^artifact:\/\//);

    const unrelated = await store.put(Buffer.from(onePixelPng), "image/png");
    await assert.rejects(
      registry.execute(
        "read_image",
        identity,
        { artifactRef: unrelated.ref.replace(/.$/, unrelated.ref.endsWith("a") ? "b" : "a") },
        { ...context, actionId: "act_image_denied" },
      ),
      (error) => error?.code === "IMAGE_ATTACHMENT_DENIED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized transparent PNG is downsampled while retaining PNG transparency", async () => {
  const source = await sharp({
    create: {
      width: 2_400,
      height: 1_200,
      channels: 4,
      background: { r: 30, g: 80, b: 130, alpha: 0.5 },
    },
  }).png().toBuffer();
  const prepared = await prepareImageBytes(source, { maxEdgePx: 800 });
  assert.equal(prepared.mediaType, "image/png");
  assert.equal(prepared.width, 800);
  assert.equal(prepared.height, 400);
  assert.equal(prepared.downsampled, true);
  assert.equal((await sharp(prepared.bytes).metadata()).hasAlpha, true);
});

test("image ingestion rejects MIME conflicts, pixel limits, and unauthorized URL fetches", async () => {
  await assert.rejects(
    prepareImageBytes(onePixelPng, { declaredMediaType: "image/jpeg" }),
    (error) => error?.code === "IMAGE_MEDIA_TYPE_MISMATCH",
  );
  const twoByTwo = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).png().toBuffer();
  await assert.rejects(
    prepareImageBytes(twoByTwo, { maxDecodePixels: 1 }),
    (error) => error?.code === "IMAGE_DECODE_FAILED" || error?.code === "IMAGE_PIXEL_LIMIT",
  );
  const root = await mkdtemp(join(tmpdir(), "qi-image-"));
  try {
    const service = new ImageIngestService({ artifactStore: new FileArtifactStore(root) });
    await assert.rejects(
      service.ingestUrl("https://example.com/image.png", { networkAuthorized: false }),
      (error) => error?.code === "AUTHORITY_DENIED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("URL detection preserves order for Markdown, standalone, and extension candidates", () => {
  const input = [
    "See ![hero](https://cdn.example/asset?id=1)",
    "https://example.com/reference",
    "and embedded=https://static.example/mock.webp?x=1.",
  ].join("\n");
  assert.deepEqual(
    detectImageUrlCandidates(input).map((candidate) => candidate.url),
    [
      "https://cdn.example/asset?id=1",
      "https://example.com/reference",
      "https://static.example/mock.webp?x=1",
    ],
  );
});
