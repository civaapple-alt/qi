import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_PROVIDER_PROFILES,
  installProviderCatalogOverBuiltins,
  mergeProviderCatalogs,
  parseProviderCatalogDocument,
  requireProviderProfile,
  resetProviderCatalog,
  resolveChatThinkingWire,
  resolveModelCapabilities,
  resolveResponsesThinkingWire,
} from "@civaapple/qi-ai";

test.afterEach(() => {
  resetProviderCatalog();
});

test("builtin catalog loads eight providers with wire hints", () => {
  assert.equal(BUILTIN_PROVIDER_PROFILES.length, 8);
  assert.equal(requireProviderProfile("kimi").wire?.chatThinking, "kimi_effort");
  assert.equal(
    requireProviderProfile("volcengine-agent-plan").wire?.responsesThinking,
    "thinking_type_and_reasoning_effort",
  );
  assert.equal(requireProviderProfile("compatible").imageInputDefault, false);
});

test("parseProviderCatalogDocument accepts snake_case TOML-shaped tables", () => {
  const profiles = parseProviderCatalogDocument({
    provider: [{
      id: "my-gateway",
      display_name: "My Gateway",
      wire_api: "chat.completions",
      official_base_url: "https://api.example.com/v1",
      official_hosts: ["api.example.com"],
      auth_schemes: ["api-key"],
      default_model: "cool-1",
      context_tokens: 128_000,
      capabilities: {
        chat_completions: true,
        responses: false,
        streaming: true,
        tool_calls: true,
        reasoning: true,
        usage: true,
        request_metadata: false,
      },
      wire: {
        chat_thinking: "thinking_type_and_effort",
        chat_output_token_field: "max_tokens",
      },
      models: [{
        id: "cool-1",
        display_name: "Cool 1",
        context_tokens: 128_000,
        thinking: {
          mode: "effort",
          supported_efforts: ["low", "high"],
          default_effort: "high",
          allow_disable: false,
        },
      }],
    }],
  });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].displayName, "My Gateway");
  assert.equal(profiles[0].wire?.chatThinking, "thinking_type_and_effort");
  assert.equal(profiles[0].models?.[0]?.thinking?.defaultEffort, "high");
});

test("merge overlays replace models and install custom providers", () => {
  const overlay = parseProviderCatalogDocument({
    id: "kimi",
    displayName: "Kimi Code",
    wireApi: "chat.completions",
    officialBaseURL: "https://api.kimi.com/coding/v1",
    officialHosts: ["api.kimi.com"],
    authSchemes: ["api-key"],
    contextTokens: 1_048_576,
    capabilities: {
      chatCompletions: true,
      responses: false,
      streaming: true,
      toolCalls: true,
      reasoning: true,
      usage: true,
      requestMetadata: false,
    },
    models: [{
      id: "k3-future",
      displayName: "K3 Future",
      contextTokens: 2_000_000,
      thinking: {
        mode: "effort",
        supportedEfforts: ["low", "high", "max"],
        defaultEffort: "high",
      },
    }],
  });
  const merged = mergeProviderCatalogs(BUILTIN_PROVIDER_PROFILES, overlay);
  const kimi = merged.find((profile) => profile.id === "kimi");
  assert.ok(kimi?.models?.some((model) => model.id === "k3"));
  assert.ok(kimi?.models?.some((model) => model.id === "k3-future"));
  installProviderCatalogOverBuiltins(overlay);
  assert.ok(requireProviderProfile("kimi").models?.some((model) => model.id === "k3-future"));
});

test("resolveChatThinkingWire uses dialects without profile.id branches", () => {
  const kimi = requireProviderProfile("kimi");
  assert.deepEqual(resolveChatThinkingWire(kimi, "k3", "high"), { reasoningEffort: "high" });
  assert.deepEqual(resolveChatThinkingWire(kimi, "k3", "none"), {
    thinking: { type: "disabled" },
  });
  assert.deepEqual(resolveChatThinkingWire(kimi, "kimi-for-coding", undefined), {
    thinking: { type: "enabled", keep: "all" },
  });

  const deepseek = requireProviderProfile("deepseek");
  assert.deepEqual(resolveChatThinkingWire(deepseek, "deepseek-v4-pro", "low"), {
    thinking: { type: "enabled" },
    reasoningEffort: "low",
  });

  const qianwen = requireProviderProfile("qianwenai");
  assert.deepEqual(resolveChatThinkingWire(qianwen, "glm-5-2", "none"), {
    enableThinking: false,
  });
});

test("resolveResponsesThinkingWire encodes Volcengine dialect", () => {
  const volc = requireProviderProfile("volcengine-agent-plan");
  assert.deepEqual(resolveResponsesThinkingWire(volc, "glm-latest", "medium"), {
    thinking: { type: "enabled" },
    reasoning: { effort: "medium" },
  });
  assert.deepEqual(resolveResponsesThinkingWire(volc, "glm-latest", "none"), {
    thinking: { type: "disabled" },
  });
  assert.equal(resolveResponsesThinkingWire(volc, "minimax-m2.7", "high"), undefined);
});

test("resolveModelCapabilities applies window percent, image defaults, and UI efforts", () => {
  const kimi = requireProviderProfile("kimi");
  const resolved = resolveModelCapabilities(kimi, "k3");
  assert.deepEqual(resolved.effortsForUi, ["low", "high", "max"]);
  assert.equal(resolved.effectiveEffort, "high");
  assert.equal(resolved.imageInput, true);

  const compatible = requireProviderProfile("compatible");
  const compat = resolveModelCapabilities(compatible, "gpt-4o-mini");
  assert.equal(compat.imageInput, false);
  assert.equal(compat.catalogAllowsImage, false);
});
