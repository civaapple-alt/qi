import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-capability";
import {
  AuthorityDeniedError,
  FileArtifactStore,
  ToolFailure,
  ToolRegistry,
  createFetchTool,
} from "@civaapple/qi-tools";

const publicAddress = { address: "93.184.216.34", family: 4 };

async function withRegistry(dependencies, run, authorized = true) {
  const root = await mkdtemp(join(tmpdir(), "qi-network-fetch-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts);
  const broker = new InMemoryCapabilityBroker();
  if (authorized) {
    broker.grant({
      leaseId: "lea_network_test",
      subject: "agent_main",
      tools: ["fetch"],
      effects: ["read"],
      resources: ["network:https://**", "network:http://**"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  }
  const registry = new ToolRegistry(broker);
  registry.register("fetch", createFetchTool(dependencies));
  const identity = registry.catalog().find((entry) => entry.name === "fetch")?.identity;
  assert.ok(identity);
  const context = {
    sessionId: "ses_network_001",
    runId: "run_network_001",
    stepId: "stp_network_001",
    actionId: "act_network_001",
    subject: "agent_main",
    workspaceRoot: root,
    artifactStore: new FileArtifactStore(artifacts),
  };
  try {
    await run({ registry, identity, context });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("fetch returns bounded untrusted text with raw response evidence", async () => {
  const raw = Buffer.from("<html><head><title>Example &amp; Docs</title><script>secret()</script></head><body><main><h1>Quickstart</h1><p>Use <code>responses.create</code>.</p></main></body></html>");
  const requested = [];
  await withRegistry({
    resolve: async () => [publicAddress],
    request: async (url, address) => {
      requested.push({ url: url.href, address });
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: raw };
    },
  }, async ({ registry, identity, context }) => {
    const settlement = await registry.execute("fetch", identity, { url: "https://example.com/docs#typescript" }, context);
    assert.deepEqual(requested, [{ url: "https://example.com/docs", address: publicAddress }]);
    assert.equal(settlement.output.requestedUrl, "https://example.com/docs");
    assert.equal(settlement.output.finalUrl, "https://example.com/docs");
    assert.equal(settlement.output.title, "Example & Docs");
    assert.match(settlement.output.content, /Quickstart/);
    assert.match(settlement.output.content, /responses\.create/);
    assert.doesNotMatch(settlement.output.content, /secret/);
    assert.equal(settlement.output.untrusted, true);
    assert.equal(settlement.output.rawBytes, raw.byteLength);
    assert.equal(settlement.output.sha256, createHash("sha256").update(raw).digest("hex"));
  });
});

test("fetch is default-deny and never resolves a target without authority", async () => {
  let resolved = false;
  await withRegistry({
    resolve: async () => {
      resolved = true;
      return [publicAddress];
    },
    request: async () => { throw new Error("must not request"); },
  }, async ({ registry, identity, context }) => {
    await assert.rejects(
      registry.execute("fetch", identity, { url: "https://example.com/" }, context),
      (error) => error instanceof AuthorityDeniedError,
    );
    assert.equal(resolved, false);
  }, false);
});

test("fetch rejects literal, local-name, and DNS-resolved private targets", async () => {
  let requested = false;
  const dependencies = {
    resolve: async () => [publicAddress, { address: "10.0.0.8", family: 4 }],
    request: async () => {
      requested = true;
      throw new Error("must not request");
    },
  };
  await withRegistry(dependencies, async ({ registry, identity, context }) => {
    for (const url of [
      "http://127.0.0.1/",
      "https://[::ffff:127.0.0.1]/",
      "https://service.local/",
      "https://example.com/",
    ]) {
      await assert.rejects(
        registry.execute("fetch", identity, { url }, context),
        (error) => error instanceof ToolFailure && error.code === "NETWORK_TARGET_DENIED",
      );
    }
    assert.equal(requested, false);
  });
});

test("fetch revalidates every redirect and refuses a private destination", async () => {
  let requests = 0;
  await withRegistry({
    resolve: async () => [publicAddress],
    request: async () => {
      requests += 1;
      return { status: 302, headers: { location: "https://127.0.0.1/private" }, body: new Uint8Array() };
    },
  }, async ({ registry, identity, context }) => {
    await assert.rejects(
      registry.execute("fetch", identity, { url: "https://example.com/start" }, context),
      (error) => error instanceof ToolFailure && error.code === "NETWORK_TARGET_DENIED",
    );
    assert.equal(requests, 1);
  });
});

test("fetch refuses HTTPS redirect downgrade", async () => {
  await withRegistry({
    resolve: async () => [publicAddress],
    request: async () => ({
      status: 302,
      headers: { location: "http://example.com/insecure" },
      body: new Uint8Array(),
    }),
  }, async ({ registry, identity, context }) => {
    await assert.rejects(
      registry.execute("fetch", identity, { url: "https://example.com/start" }, context),
      (error) => error instanceof ToolFailure && error.code === "NETWORK_REDIRECT_DOWNGRADE",
    );
  });
});

test("fetch cancellation stops before DNS or transport entry", async () => {
  let resolved = false;
  let requested = false;
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await withRegistry({
    resolve: async () => {
      resolved = true;
      return [publicAddress];
    },
    request: async () => {
      requested = true;
      throw new Error("must not request");
    },
  }, async ({ registry, identity, context }) => {
    await assert.rejects(
      registry.execute(
        "fetch",
        identity,
        { url: "https://example.com/" },
        { ...context, signal: controller.signal },
      ),
      (error) => error instanceof Error && error.message === "user cancelled",
    );
    assert.equal(resolved, false);
    assert.equal(requested, false);
  });
});

test("fetch rejects credentials, non-web ports, binary content, and oversized responses", async () => {
  let response = { status: 200, headers: { "content-type": "image/png" }, body: Buffer.from("png") };
  await withRegistry({
    resolve: async () => [publicAddress],
    request: async () => response,
  }, async ({ registry, identity, context }) => {
    await assert.rejects(
      registry.execute("fetch", identity, { url: "https://user:secret@example.com/" }, context),
      (error) => error instanceof ToolFailure && error.code === "NETWORK_CREDENTIALS_DENIED",
    );
    await assert.rejects(
      registry.execute("fetch", identity, { url: "https://example.com:8443/" }, context),
      (error) => error instanceof ToolFailure && error.code === "NETWORK_PORT_DENIED",
    );
    await assert.rejects(
      registry.execute("fetch", identity, { url: "https://example.com/image" }, context),
      (error) => error instanceof ToolFailure && error.code === "NETWORK_CONTENT_TYPE_DENIED",
    );
    response = {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.alloc(1024 * 1024 + 1),
    };
    await assert.rejects(
      registry.execute("fetch", identity, { url: "https://example.com/large" }, context),
      (error) => error instanceof ToolFailure && error.code === "NETWORK_RESPONSE_TOO_LARGE",
    );
  });
});

test("fetch truncates extracted output independently of the raw response limit", async () => {
  await withRegistry({
    resolve: async () => [publicAddress],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.from("x".repeat(1_500)),
    }),
  }, async ({ registry, identity, context }) => {
    const settlement = await registry.execute(
      "fetch",
      identity,
      { url: "https://example.com/long", maxChars: 1_000 },
      context,
    );
    assert.equal(settlement.output.content.length, 1_000);
    assert.equal(settlement.output.truncated, true);
    assert.equal(settlement.output.rawBytes, 1_500);
  });
});
