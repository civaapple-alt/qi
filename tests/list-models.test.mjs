import assert from "node:assert/strict";
import test from "node:test";
import {
  getProviderProfile,
  listOpenAICompatibleModels,
  mergeProviderModels,
} from "@civaapple/qi-ai";

test("listOpenAICompatibleModels parses Kimi-style /models payloads", async () => {
  const calls = [];
  const models = await listOpenAICompatibleModels(
    "https://api.kimi.com/coding/v1/",
    "sk-test",
    {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          async json() {
            return {
              object: "list",
              data: [
                {
                  id: "k3",
                  object: "model",
                  owned_by: "moonshot",
                  context_length: 1_048_576,
                  supports_image_in: true,
                  supports_video_in: true,
                  supports_reasoning: true,
                },
                {
                  id: "future-kimi",
                  object: "model",
                  context_length: 128_000,
                  supports_image_in: false,
                  supports_reasoning: true,
                },
                { object: "model" },
              ],
            };
          },
        };
      },
    },
  );

  assert.equal(calls[0]?.url, "https://api.kimi.com/coding/v1/models");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.match(String(calls[0]?.init?.headers?.Authorization), /Bearer sk-test/);
  assert.deepEqual(models, [
    {
      id: "k3",
      contextLength: 1_048_576,
      supportsImageIn: true,
      supportsVideoIn: true,
      supportsReasoning: true,
      ownedBy: "moonshot",
    },
    {
      id: "future-kimi",
      contextLength: 128_000,
      supportsImageIn: false,
      supportsReasoning: true,
    },
  ]);
});

test("listOpenAICompatibleModels fails closed on HTTP errors", async () => {
  await assert.rejects(
    () => listOpenAICompatibleModels("https://api.kimi.com/coding/v1", "sk-bad", {
      fetch: async () => ({
        ok: false,
        status: 401,
        async text() {
          return '{"error":{"message":"unauthorized"}}';
        },
      }),
    }),
    /HTTP 401/,
  );
});

test("mergeProviderModels keeps catalog thinking authority and appends remote-only ids", () => {
  const kimi = getProviderProfile("kimi");
  assert.ok(kimi);
  const merged = mergeProviderModels(kimi, [
    {
      id: "k3",
      contextLength: 900_000,
      supportsImageIn: true,
      supportsReasoning: true,
    },
    {
      id: "future-kimi",
      contextLength: 64_000,
      supportsReasoning: true,
    },
  ]);

  const k3 = merged.find((model) => model.id === "k3");
  assert.ok(k3);
  assert.equal(k3.catalogued, true);
  assert.equal(k3.displayName, "Kimi K3");
  assert.equal(k3.contextTokens, 900_000);
  assert.deepEqual(k3.profile?.thinking, {
    mode: "effort",
    supportedEfforts: ["low", "high", "max"],
    defaultEffort: "high",
  });

  const coding = merged.find((model) => model.id === "kimi-for-coding");
  assert.ok(coding);
  assert.equal(coding.catalogued, true);
  assert.equal(coding.remote, undefined);

  const remoteOnly = merged.find((model) => model.id === "future-kimi");
  assert.ok(remoteOnly);
  assert.equal(remoteOnly.catalogued, false);
  assert.equal(remoteOnly.displayName, "future-kimi");
  assert.equal(remoteOnly.contextTokens, 64_000);
  assert.equal(remoteOnly.profile, undefined);
});

test("mergeProviderModels without remote returns the static catalog", () => {
  const kimi = getProviderProfile("kimi");
  assert.ok(kimi);
  const merged = mergeProviderModels(kimi, undefined);
  assert.deepEqual(
    merged.map((model) => model.id),
    (kimi.models ?? []).map((model) => model.id),
  );
  assert.equal(merged.every((model) => model.catalogued), true);
});
