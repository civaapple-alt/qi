import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import {
  FileArtifactStore,
  ToolRegistry,
  createFetchTool,
  createWebMapTool,
} from "@civaapple/qi-node/tools";

const publicAddress = { address: "93.184.216.34", family: 4 };

const deepseekSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://api-docs.deepseek.com/zh-cn/quick_start/pricing</loc></url>
  <url><loc>https://api-docs.deepseek.com/zh-cn/guides/thinking</loc></url>
  <url><loc>https://api-docs.deepseek.com/zh-cn/api/create-chat-completion</loc></url>
  <url><loc>https://other.example/escape</loc></url>
</urlset>`;

const navHtml = `<!DOCTYPE html><html><head><title>Docs</title></head><body>
<nav>
  <a href="/zh-cn/quick_start/pricing">Pricing</a>
  <a href="/zh-cn/guides/thinking">Thinking</a>
  <a href="https://external.example/x">External</a>
</nav>
<main><h1>Welcome</h1><p>Body copy only.</p></main>
</body></html>`;

async function withNetworkTools(dependencies, run, tools = ["web_map", "fetch"]) {
  const root = await mkdtemp(join(tmpdir(), "qi-web-map-"));
  const artifacts = join(root, ".artifacts");
  await mkdir(artifacts);
  const broker = new InMemoryCapabilityBroker();
  broker.grant({
    leaseId: "lea_web_map_test",
    subject: "agent_main",
    tools,
    effects: ["read"],
    resources: ["network:https://**", "network:http://**"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const registry = new ToolRegistry(broker);
  if (tools.includes("web_map")) registry.register("web_map", createWebMapTool(dependencies));
  if (tools.includes("fetch")) registry.register("fetch", createFetchTool(dependencies));
  const context = {
    sessionId: "ses_web_map_001",
    runId: "run_web_map_001",
    stepId: "stp_web_map_001",
    actionId: "act_web_map_001",
    subject: "agent_main",
    workspaceRoot: root,
    artifactStore: new FileArtifactStore(artifacts),
  };
  try {
    await run({ registry, context });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function identity(registry, name) {
  const entry = registry.catalog().find((item) => item.name === name)?.identity;
  assert.ok(entry);
  return entry;
}

test("web_map discovers DeepSeek-shaped sitemap urls and filters pathPrefix", async () => {
  const requested = [];
  await withNetworkTools({
    resolve: async () => [publicAddress],
    request: async (url) => {
      requested.push(url.href);
      if (url.pathname.endsWith("/sitemap.xml")) {
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          body: Buffer.from(deepseekSitemap),
        };
      }
      if (url.pathname.endsWith("/llms.txt") || url.pathname.endsWith("/robots.txt")) {
        return { status: 404, headers: { "content-type": "text/plain" }, body: Buffer.from("missing") };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from("<html><body>entry</body></html>"),
      };
    },
  }, async ({ registry, context }) => {
    const settlement = await registry.execute(
      "web_map",
      identity(registry, "web_map"),
      {
        url: "https://api-docs.deepseek.com/zh-cn/",
        pathPrefix: "/zh-cn/quick_start",
      },
      context,
    );
    assert.equal(settlement.output.entryUrl, "https://api-docs.deepseek.com/zh-cn/");
    assert.equal(settlement.output.untrusted, true);
    assert.deepEqual(
      settlement.output.links.map((link) => link.url),
      ["https://api-docs.deepseek.com/zh-cn/quick_start/pricing"],
    );
    assert.equal(settlement.output.links[0].source, "sitemap");
    assert.ok(settlement.output.sourcesTried.some((item) => item.includes("sitemap.xml")));
    assert.ok(requested.some((href) => href.endsWith("/zh-cn/sitemap.xml")));
  });
});

test("web_map skips HTML-served llms.txt and falls back to nav HTML links", async () => {
  await withNetworkTools({
    resolve: async () => [publicAddress],
    request: async (url) => {
      if (url.pathname.endsWith("/sitemap.xml") || url.pathname.endsWith("/robots.txt")) {
        return { status: 404, headers: { "content-type": "text/plain" }, body: Buffer.from("missing") };
      }
      if (url.pathname.endsWith("/llms.txt")) {
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: Buffer.from("<!DOCTYPE html><html><body><p>Not a machine list https://evil.example/x</p></body></html>"),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(navHtml),
      };
    },
  }, async ({ registry, context }) => {
    const settlement = await registry.execute(
      "web_map",
      identity(registry, "web_map"),
      { url: "https://api-docs.deepseek.com/zh-cn/" },
      context,
    );
    assert.deepEqual(
      settlement.output.links.map((link) => ({ url: link.url, source: link.source, title: link.title })),
      [
        {
          url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
          source: "html",
          title: "Pricing",
        },
        {
          url: "https://api-docs.deepseek.com/zh-cn/guides/thinking",
          source: "html",
          title: "Thinking",
        },
      ],
    );
    assert.equal(
      settlement.output.links.some((link) => link.url.includes("evil.example")),
      false,
    );
  });
});

test("web_map follows robots Sitemap and one sitemap-index level", async () => {
  const nested = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/docs/a</loc></url>
  <url><loc>https://example.com/docs/b</loc></url>
</urlset>`;
  const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-docs.xml</loc></sitemap>
</sitemapindex>`;
  await withNetworkTools({
    resolve: async () => [publicAddress],
    request: async (url) => {
      if (url.pathname === "/robots.txt") {
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: Buffer.from("User-agent: *\nSitemap: https://example.com/sitemap-index.xml\n"),
        };
      }
      if (url.pathname === "/sitemap-index.xml") {
        return { status: 200, headers: { "content-type": "application/xml" }, body: Buffer.from(index) };
      }
      if (url.pathname === "/sitemap-docs.xml") {
        return { status: 200, headers: { "content-type": "application/xml" }, body: Buffer.from(nested) };
      }
      if (url.pathname.endsWith("/sitemap.xml") || url.pathname.endsWith("/llms.txt")) {
        return { status: 404, headers: { "content-type": "text/plain" }, body: Buffer.from("missing") };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<html><body>home</body></html>"),
      };
    },
  }, async ({ registry, context }) => {
    const settlement = await registry.execute(
      "web_map",
      identity(registry, "web_map"),
      { url: "https://example.com/" },
      context,
    );
    assert.deepEqual(
      settlement.output.links.map((link) => link.url).sort(),
      ["https://example.com/docs/a", "https://example.com/docs/b"],
    );
    assert.ok(settlement.output.links.every((link) => link.source === "robots"));
  });
});

test("fetch keeps nav links in links while stripping them from content", async () => {
  await withNetworkTools({
    resolve: async () => [publicAddress],
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(navHtml),
    }),
  }, async ({ registry, context }) => {
    const settlement = await registry.execute(
      "fetch",
      identity(registry, "fetch"),
      { url: "https://api-docs.deepseek.com/zh-cn/" },
      context,
    );
    assert.match(settlement.output.content, /Welcome/);
    assert.match(settlement.output.content, /Body copy only/);
    assert.doesNotMatch(settlement.output.content, /Pricing/);
    assert.doesNotMatch(settlement.output.content, /Thinking/);
    assert.deepEqual(
      settlement.output.links.map((link) => link.url),
      [
        "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
        "https://api-docs.deepseek.com/zh-cn/guides/thinking",
      ],
    );
  }, ["fetch"]);
});

test("web_map parses text/plain llms.txt URL lines", async () => {
  await withNetworkTools({
    resolve: async () => [publicAddress],
    request: async (url) => {
      if (url.pathname.endsWith("/llms.txt")) {
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: Buffer.from([
            "# Docs",
            "- [Pricing](https://example.com/zh-cn/quick_start/pricing)",
            "https://example.com/zh-cn/guides/thinking",
          ].join("\n")),
        };
      }
      if (url.pathname.endsWith("/sitemap.xml") || url.pathname.endsWith("/robots.txt")) {
        return { status: 404, headers: { "content-type": "text/plain" }, body: Buffer.from("missing") };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<html><body>entry</body></html>"),
      };
    },
  }, async ({ registry, context }) => {
    const settlement = await registry.execute(
      "web_map",
      identity(registry, "web_map"),
      { url: "https://example.com/zh-cn/" },
      context,
    );
    assert.deepEqual(
      settlement.output.links.map((link) => link.url).sort(),
      [
        "https://example.com/zh-cn/guides/thinking",
        "https://example.com/zh-cn/quick_start/pricing",
      ],
    );
    assert.ok(settlement.output.links.every((link) => link.source === "llms"));
  });
});
