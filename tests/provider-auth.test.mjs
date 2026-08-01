import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialBroker } from "@civaapple/qi-agent/capability";
import { EncryptedFileCredentialStore } from "@civaapple/qi-node/storage";
import {
  createModelPortForProfile,
  getProviderModelProfile,
  getProviderProfile,
  listProviderProfiles,
  providerModelContextTokens,
  providerModelOutputReserveTokens,
  resolveProviderWireApi,
} from "@civaapple/qi-ai";
import { AuthSession, parseLoginCommand } from "../apps/cli/dist/auth.js";
import {
  createFetchKimiOAuthTransport,
  pollKimiDeviceToken,
  requestKimiDeviceAuthorization,
  serializeKimiSecret,
} from "../apps/cli/dist/kimi-oauth.js";
import { resolveProviderConfig, formatProviderLabel, normalizeAccountAlias } from "../apps/cli/dist/provider.js";

test("provider profiles declare an explicit wire API and capability matrix", () => {
  const ids = listProviderProfiles().map((profile) => profile.id);
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("kimi"));
  assert.ok(ids.includes("compatible"));
  assert.ok(ids.includes("deepseek"));
  assert.ok(ids.includes("volcengine-agent-plan"));
  assert.ok(ids.includes("qianwenai"));
  assert.equal(getProviderProfile("openai")?.wireApi, "responses");
  assert.equal(getProviderProfile("kimi")?.wireApi, "chat.completions");
  assert.equal(getProviderProfile("compatible")?.wireApi, "chat.completions");
  assert.equal(getProviderProfile("deepseek")?.wireApi, "responses");
  assert.equal(getProviderProfile("volcengine-agent-plan")?.wireApi, "responses");
  assert.equal(getProviderProfile("qianwenai")?.wireApi, "responses");
  assert.equal(getProviderProfile("compatible")?.displayName, "OpenAI Compatible");
  assert.equal(getProviderProfile("openai")?.officialBaseURL, "https://api.openai.com/v1");
  assert.equal(getProviderProfile("kimi")?.capabilities.toolCalls, true);
  assert.equal(getProviderProfile("kimi")?.capabilities.reasoning, true);
  assert.equal(getProviderProfile("kimi")?.capabilities.responses, false);
  const kimi = getProviderProfile("kimi");
  assert.ok(kimi);
  assert.equal(kimi.defaultModel, "k3");
  assert.equal(providerModelContextTokens(kimi, "k3"), 1_048_576);
  assert.equal(providerModelContextTokens(kimi, "k3-256k"), 262_144);
  assert.equal(providerModelContextTokens(kimi, "kimi-for-coding"), 262_144);
  assert.equal(providerModelContextTokens(kimi, "kimi-for-coding-highspeed"), 262_144);
  assert.deepEqual(getProviderModelProfile(kimi, "k3")?.thinking, {
    mode: "effort",
    supportedEfforts: ["low", "high", "max"],
    defaultEffort: "high",
    allowDisable: false,
  });
  assert.deepEqual(getProviderModelProfile(kimi, "k3")?.inputModalities, ["text", "image"]);
  assert.deepEqual(getProviderModelProfile(kimi, "kimi-for-coding")?.thinking, {
    mode: "always",
  });
  const deepseek = getProviderProfile("deepseek");
  assert.ok(deepseek);
  assert.equal(deepseek.defaultModel, "deepseek-v4-flash");
  assert.equal(providerModelContextTokens(deepseek, "deepseek-v4-flash"), 1_048_576);
  assert.equal(providerModelContextTokens(deepseek, "deepseek-v4-pro"), 1_048_576);
  assert.equal(providerModelOutputReserveTokens(deepseek, "deepseek-v4-flash"), 65_536);
  assert.equal(providerModelOutputReserveTokens(deepseek, "deepseek-v4-pro"), 65_536);
  assert.equal(resolveProviderWireApi(deepseek, "deepseek-v4-flash"), "responses");
  assert.equal(resolveProviderWireApi(deepseek, "deepseek-v4-pro"), "chat.completions");
  assert.equal(deepseek.capabilities.requestMetadata, false);
  assert.equal(deepseek.capabilities.reasoning, true);
  assert.deepEqual(getProviderModelProfile(deepseek, "deepseek-v4-flash")?.thinking, {
    mode: "effort",
    supportedEfforts: ["low", "high", "max"],
    defaultEffort: "high",
    allowDisable: false,
  });
  assert.equal(
    createModelPortForProfile(deepseek, { apiKey: "sk-test", model: "deepseek-v4-flash" }).constructor.name,
    "OpenAIResponsesModelPort",
  );
  assert.equal(
    createModelPortForProfile(deepseek, { apiKey: "sk-test", model: "deepseek-v4-pro" }).constructor.name,
    "OpenAIChatCompletionsModelPort",
  );
  const ark = getProviderProfile("volcengine-agent-plan");
  assert.ok(ark);
  assert.equal(ark.displayName, "Volcengine Agent Plan");
  assert.equal(ark.defaultModel, "glm-latest");
  assert.equal(ark.officialBaseURL, "https://ark.cn-beijing.volces.com/api/plan/v3");
  assert.equal(ark.envApiKey, "ARK_API_KEY");
  assert.equal(ark.capabilities.requestMetadata, false);
  assert.equal(ark.capabilities.reasoning, true);
  assert.equal(providerModelContextTokens(ark, "glm-latest"), 1_048_576);
  assert.equal(providerModelOutputReserveTokens(ark, "glm-latest"), 65_536);
  assert.deepEqual(getProviderModelProfile(ark, "glm-latest")?.thinking, {
    mode: "effort",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "high",
    allowDisable: false,
  });
  assert.equal(getProviderModelProfile(ark, "minimax-m2.7")?.thinking, undefined);
  assert.equal(getProviderModelProfile(ark, "kimi-k2.6")?.thinking, undefined);
  assert.equal(getProviderModelProfile(ark, "kimi-k2.7-code")?.thinking, undefined);
  assert.equal(
    createModelPortForProfile(ark, { apiKey: "sk-test", model: "glm-latest" }).constructor.name,
    "OpenAIResponsesModelPort",
  );
  const qianwenai = getProviderProfile("qianwenai");
  assert.ok(qianwenai);
  assert.equal(qianwenai.displayName, "Qianwen AI Token Plan");
  assert.equal(qianwenai.defaultModel, "qwen3.8-max-preview");
  assert.equal(
    qianwenai.officialBaseURL,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  );
  assert.deepEqual(qianwenai.officialHosts, ["token-plan.cn-beijing.maas.aliyuncs.com"]);
  assert.equal(qianwenai.envApiKey, "QIANWENAI_API_KEY");
  assert.equal(qianwenai.envBaseURL, "QIANWENAI_BASE_URL");
  assert.equal(qianwenai.envModel, "QIANWENAI_MODEL");
  assert.equal(qianwenai.capabilities.requestMetadata, false);
  assert.equal(qianwenai.capabilities.reasoning, true);
  assert.equal(providerModelContextTokens(qianwenai, "qwen3.8-max-preview"), 1_048_576);
  assert.equal(providerModelOutputReserveTokens(qianwenai, "qwen3.8-max-preview"), 65_536);
  assert.deepEqual(getProviderModelProfile(qianwenai, "qwen3.8-max-preview")?.thinking, {
    mode: "effort",
    supportedEfforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    allowDisable: false,
  });
  assert.deepEqual(getProviderModelProfile(qianwenai, "qwen3.8-max-preview")?.inputModalities, [
    "text",
    "image",
  ]);
  assert.deepEqual(getProviderModelProfile(qianwenai, "qwen3.7-max")?.inputModalities, ["text"]);
  assert.ok(qianwenai.models?.some((model) => model.id === "glm-5-2"));
  assert.ok(qianwenai.models?.some((model) => model.id === "deepseek-v4-pro"));
  assert.equal(resolveProviderWireApi(qianwenai, "qwen3.8-max-preview"), "responses");
  assert.equal(resolveProviderWireApi(qianwenai, "glm-5-2"), "chat.completions");
  assert.equal(resolveProviderWireApi(qianwenai, "deepseek-v4-pro"), "chat.completions");
  assert.equal(
    createModelPortForProfile(qianwenai, { apiKey: "sk-sp-test", model: "qwen3.8-max-preview" })
      .constructor.name,
    "OpenAIResponsesModelPort",
  );
  assert.equal(
    createModelPortForProfile(qianwenai, { apiKey: "sk-sp-test", model: "glm-5-2" }).constructor.name,
    "OpenAIChatCompletionsModelPort",
  );
});

test("compatible provider labels use the configured name", () => {
  assert.equal(formatProviderLabel("compatible", "qianwenai"), "qianwenai");
  assert.equal(formatProviderLabel("compatible", "zhipu"), "zhipu");
  assert.equal(formatProviderLabel("compatible", "default"), "compatible");
  assert.equal(formatProviderLabel("openai", "default"), "openai");
  assert.equal(formatProviderLabel("qianwenai", "default"), "qianwenai");
  assert.equal(normalizeAccountAlias("QianWenAI"), "qianwenai");
  assert.equal(normalizeAccountAlias(undefined), "default");
  assert.throws(() => normalizeAccountAlias("bad name"), /Invalid name/);
});

test("resolveProviderConfig allows missing credentials for unauthenticated startup", () => {
  const config = resolveProviderConfig({
    provider: "kimi",
    model: "kimi-for-coding",
    allowMissingCredential: true,
    environment: {},
  });
  assert.equal(config.authStatus, "missing");
  assert.equal(config.wireApi, "chat.completions");
  assert.equal(config.apiKey, undefined);
});

test("resolveProviderConfig selects DeepSeek wire API and effort per model", () => {
  const flash = resolveProviderConfig({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    reasoningEffort: "minimal",
    allowMissingCredential: true,
    environment: {},
  });
  assert.equal(flash.wireApi, "responses");
  assert.equal(flash.reasoningEffort, "low");
  const pro = resolveProviderConfig({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    reasoningEffort: "max",
    allowMissingCredential: true,
    environment: {},
  });
  assert.equal(pro.wireApi, "chat.completions");
  assert.equal(pro.reasoningEffort, "max");
});

test("resolveProviderConfig selects Volcengine Agent Plan Responses and effort", () => {
  const config = resolveProviderConfig({
    provider: "volcengine-agent-plan",
    model: "glm-latest",
    reasoningEffort: "medium",
    allowMissingCredential: true,
    environment: {},
  });
  assert.equal(config.wireApi, "responses");
  assert.equal(config.reasoningEffort, "medium");
  assert.equal(config.profile.envApiKey, "ARK_API_KEY");
  assert.equal(config.baseURL, "https://ark.cn-beijing.volces.com/api/plan/v3");
});

test("resolveProviderConfig selects Qianwen AI Token Plan Responses and effort", () => {
  const config = resolveProviderConfig({
    provider: "qianwenai",
    model: "qwen3.8-max-preview",
    reasoningEffort: "medium",
    allowMissingCredential: true,
    environment: {},
  });
  assert.equal(config.wireApi, "responses");
  assert.equal(config.reasoningEffort, "medium");
  assert.equal(config.profile.envApiKey, "QIANWENAI_API_KEY");
  assert.equal(
    config.baseURL,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  );
  assert.equal(
    resolveProviderConfig({
      provider: "qianwenai",
      model: "qwen3.7-plus",
      reasoningEffort: "xhigh",
      allowMissingCredential: true,
      environment: {},
    }).reasoningEffort,
    "max",
  );
});

test("resolveProviderConfig normalizes K3 effort aliases and rejects unsupported values", () => {
  const base = {
    provider: "kimi",
    model: "k3",
    allowMissingCredential: true,
    environment: {},
  };
  assert.equal(resolveProviderConfig({ ...base, reasoningEffort: "xhigh" }).reasoningEffort, "max");
  assert.equal(resolveProviderConfig({ ...base, reasoningEffort: "medium" }).reasoningEffort, "medium");
  assert.equal(resolveProviderConfig({ ...base, reasoningEffort: "minimum" }).reasoningEffort, "low");
  assert.equal(resolveProviderConfig({ ...base, reasoningEffort: "none" }).reasoningEffort, "none");
  assert.equal(resolveProviderConfig({
    ...base,
    environment: { KIMI_MODEL_THINKING_EFFORT: "light" },
  }).reasoningEffort, "low");
  assert.equal(resolveProviderConfig({
    ...base,
    environment: {
      QI_REASONING_EFFORT: "medium",
      KIMI_MODEL_THINKING_EFFORT: "max",
    },
  }).reasoningEffort, "medium");
  assert.throws(
    () => resolveProviderConfig({ ...base, reasoningEffort: "extreme" }),
    /Unsupported reasoning effort/,
  );
  assert.throws(
    () => resolveProviderConfig({
      provider: "openai",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      allowMissingCredential: true,
      environment: {},
    }),
    /Kimi, DeepSeek, and Volcengine Agent Plan/,
  );
});

test("EncryptedFileCredentialStore seals and restores secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-secure-"));
  try {
    const store = new EncryptedFileCredentialStore(root);
    await store.set({
      accountId: "kimi:default",
      provider: "kimi",
      alias: "default",
      authKind: "oauth",
      secret: serializeKimiSecret({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenType: "Bearer",
      }),
    });
    const loaded = await store.get("kimi:default");
    assert.equal(loaded?.provider, "kimi");
    assert.match(loaded?.secret ?? "", /access-secret/);
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal("secret" in listed[0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CredentialBroker withCredential resolves only for matching subject/intent", async () => {
  const broker = new InMemoryCredentialBroker();
  broker.register("cred_model", "tok_secret", {
    tools: ["model.stream"],
    resources: ["provider:kimi"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    audience: "kimi",
  });
  const handle = broker.issue("cred_model", "main-agent");
  const value = await broker.withCredential(
    handle.handle,
    { actionId: "act_1", subject: "main-agent", tool: "model.stream", effect: "read", resources: ["provider:kimi"] },
    (secret) => secret,
  );
  assert.equal(value, "tok_secret");
  await assert.rejects(
    () => broker.withCredential(
      handle.handle,
      { actionId: "act_2", subject: "other", tool: "model.stream", effect: "read", resources: ["provider:kimi"] },
      (secret) => secret,
    ),
    /another subject/,
  );
});

test("Kimi device login polls until authorized and AuthSession stores a sealed OAuth secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-kimi-auth-"));
  try {
    let polls = 0;
    const transport = {
      async postForm(url, body) {
        if (url.endsWith("/device_authorization")) {
          return {
            status: 200,
            json: {
              user_code: "ABCD-EFGH",
              device_code: "device-1",
              verification_uri: "https://www.kimi.com/code/login",
              verification_uri_complete: "https://www.kimi.com/code/login?user_code=ABCD-EFGH",
              expires_in: 600,
              interval: 0,
            },
          };
        }
        polls += 1;
        if (polls < 2) return { status: 400, json: { error: "authorization_pending" } };
        return {
          status: 200,
          json: {
            access_token: "kimi-access",
            refresh_token: "kimi-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "kimi-code",
          },
        };
      },
    };
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "kimi",
        model: "kimi-for-coding",
        allowMissingCredential: true,
        environment: {},
      }),
      store: new EncryptedFileCredentialStore(root),
    });
    assert.equal(auth.status().authStatus, "missing");
    const notices = [];
    const status = await auth.loginKimiDevice({
      model: "kimi-k2.5",
      transport,
      sleep: async () => undefined,
      onAuthorization: (info) => notices.push(info.userCode),
    });
    assert.deepEqual(notices, ["ABCD-EFGH"]);
    assert.equal(status.authStatus, "ready");
    assert.equal(status.model, "kimi-k2.5");
    assert.equal(auth.requireModelPort().constructor.name, "OpenAIChatCompletionsModelPort");
    const stored = await new EncryptedFileCredentialStore(root).get("kimi:default");
    assert.equal(stored?.authKind, "oauth");
    assert.match(stored?.secret ?? "", /kimi-access/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("API-key login switches provider model and base URL for the next Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-login-switch-"));
  try {
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "openai",
        model: "gpt-5.4-mini",
        baseURL: "https://api.openai.com/v1",
        allowMissingCredential: true,
        environment: {},
      }),
      store: new EncryptedFileCredentialStore(root),
    });
    assert.equal(auth.status().authStatus, "missing");
    const status = await auth.loginApiKey("kimi", "sk-kimi-test", {
      model: "k3-256k",
      reasoningEffort: "max",
      contextWindowTokens: 300_000,
    });
    assert.equal(status.authStatus, "ready");
    assert.equal(status.provider, "kimi");
    assert.equal(status.model, "k3-256k");
    assert.equal(status.reasoningEffort, "max");
    assert.equal(status.contextWindowTokens, 300_000);
    assert.equal(status.contextWindowTokensOverride, true);
    assert.equal(status.wireApi, "chat.completions");
    assert.equal(auth.config.baseURL, "https://api.kimi.com/coding/v1");
    assert.equal(auth.config.model, "k3-256k");
    assert.equal(auth.config.reasoningEffort, "max");
    assert.equal(auth.requireModelPort().constructor.name, "OpenAIChatCompletionsModelPort");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("API-key login accepts an explicit model override", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-login-model-"));
  try {
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "openai",
        model: "gpt-5.4-mini",
        allowMissingCredential: true,
        environment: {},
      }),
      store: new EncryptedFileCredentialStore(root),
    });
    const status = await auth.loginApiKey("deepseek", "sk-deepseek-test", {
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    assert.equal(status.provider, "deepseek");
    assert.equal(status.model, "deepseek-v4-flash");
    assert.equal(status.wireApi, "responses");
    assert.equal(status.reasoningEffort, "high");
    assert.equal(auth.config.baseURL, "https://api.deepseek.com/v1");
    assert.equal(auth.requireModelPort().constructor.name, "OpenAIResponsesModelPort");

    const pro = await auth.loginApiKey("deepseek", "sk-deepseek-pro", {
      model: "deepseek-v4-pro",
    });
    assert.equal(pro.model, "deepseek-v4-pro");
    assert.equal(pro.wireApi, "chat.completions");
    assert.equal(auth.requireModelPort().constructor.name, "OpenAIChatCompletionsModelPort");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("API-key login accepts a custom OpenAI-compatible base URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-login-baseurl-"));
  try {
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "openai",
        model: "gpt-5.4-mini",
        allowMissingCredential: true,
        environment: {},
      }),
      store: new EncryptedFileCredentialStore(root),
    });
    const status = await auth.loginApiKey("compatible", "sk-compat-test", {
      alias: "qianwenai",
      model: "my-local-model",
      baseURL: "http://127.0.0.1:11434/v1",
    });
    assert.equal(status.provider, "compatible");
    assert.equal(status.accountAlias, "qianwenai");
    assert.equal(status.model, "my-local-model");
    assert.equal(status.baseURL, "http://127.0.0.1:11434/v1");
    assert.equal(status.endpointTrust, "custom");
    assert.equal(status.wireApi, "chat.completions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compatible useAccount switches between sealed named endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-compatible-use-"));
  try {
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "openai",
        model: "gpt-5.4-mini",
        allowMissingCredential: true,
        environment: {},
      }),
      store: new EncryptedFileCredentialStore(root),
    });
    await auth.loginApiKey("compatible", "sk-qwen", {
      alias: "qianwenai",
      model: "qwen-plus",
      baseURL: "https://dashscope.aliyun.com/compatible-mode/v1",
    });
    await auth.loginApiKey("compatible", "sk-zhipu", {
      alias: "zhipu",
      model: "glm-4",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
    });
    assert.equal(auth.status().accountAlias, "zhipu");

    const switched = await auth.useAccount("compatible", "qianwenai", {
      model: "qwen-plus",
      baseURL: "https://dashscope.aliyun.com/compatible-mode/v1",
    });
    assert.equal(switched.accountAlias, "qianwenai");
    assert.equal(switched.model, "qwen-plus");
    assert.equal(switched.baseURL, "https://dashscope.aliyun.com/compatible-mode/v1");
    assert.equal(switched.authStatus, "ready");

    const fromMetadata = await auth.useAccount("compatible", "zhipu");
    assert.equal(fromMetadata.accountAlias, "zhipu");
    assert.equal(fromMetadata.model, "glm-4");
    assert.equal(fromMetadata.baseURL, "https://open.bigmodel.cn/api/paas/v4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("useAccount switches sealed deepseek and kimi without re-entering keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-provider-switch-"));
  try {
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "openai",
        model: "gpt-5.4-mini",
        allowMissingCredential: true,
        environment: {},
      }),
      store: new EncryptedFileCredentialStore(root),
    });
    await auth.loginApiKey("deepseek", "sk-deepseek", {
      model: "deepseek-reasoner",
      baseURL: "https://api.deepseek.com/v1",
    });
    await auth.loginApiKey("kimi", "sk-kimi", {
      model: "kimi-for-coding",
      baseURL: "https://api.kimi.com/coding/v1",
    });
    assert.equal(auth.status().provider, "kimi");

    const accounts = await auth.listAccounts();
    assert.ok(accounts.some((account) => account.provider === "deepseek" && account.model === "deepseek-reasoner"));
    assert.ok(accounts.some((account) => account.provider === "kimi" && account.model === "kimi-for-coding"));

    const back = await auth.useAccount("deepseek", "default");
    assert.equal(back.provider, "deepseek");
    assert.equal(back.model, "deepseek-reasoner");
    assert.equal(back.baseURL, "https://api.deepseek.com/v1");
    assert.equal(back.authStatus, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("useAccount restores xAI via profile defaultModel when metadata is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-xai-switch-"));
  try {
    const store = new EncryptedFileCredentialStore(root);
    await store.set({
      accountId: "xai:default",
      provider: "xai",
      alias: "default",
      authKind: "api-key",
      secret: "xai-secret",
    });
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        allowMissingCredential: true,
        environment: {},
      }),
      store,
    });
    await auth.loginApiKey("deepseek", "sk-deepseek");
    assert.equal(auth.status().provider, "deepseek");

    const switched = await auth.useAccount("xai", "default");
    assert.equal(switched.provider, "xai");
    assert.equal(switched.model, "grok-4.5");
    assert.equal(switched.baseURL, "https://api.x.ai/v1");
    assert.equal(switched.authStatus, "ready");

    const accounts = await auth.listAccounts();
    const xai = accounts.find((account) => account.provider === "xai");
    assert.equal(xai?.model, "grok-4.5");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseLoginCommand distinguishes status, logout, device, and API key modes", () => {
  assert.deepEqual(parseLoginCommand(""), { provider: "", mode: "status" });
  assert.deepEqual(parseLoginCommand("list"), { provider: "", mode: "list" });
  assert.deepEqual(parseLoginCommand("logout kimi"), { provider: "kimi", mode: "logout" });
  assert.deepEqual(parseLoginCommand("use qianwenai"), {
    provider: "qianwenai",
    mode: "use",
    alias: "default",
  });
  assert.deepEqual(parseLoginCommand("use zhipu"), {
    provider: "compatible",
    mode: "use",
    alias: "zhipu",
  });
  assert.deepEqual(parseLoginCommand("use deepseek"), {
    provider: "deepseek",
    mode: "use",
    alias: "default",
  });
  assert.deepEqual(parseLoginCommand("use kimi"), {
    provider: "kimi",
    mode: "use",
    alias: "default",
  });
  assert.deepEqual(parseLoginCommand("kimi"), { provider: "kimi", mode: "device" });
  assert.deepEqual(parseLoginCommand("kimi device model kimi-k2.5"), {
    provider: "kimi",
    mode: "device",
    model: "kimi-k2.5",
  });
  assert.deepEqual(parseLoginCommand("kimi model kimi-for-coding"), {
    provider: "kimi",
    mode: "device",
    model: "kimi-for-coding",
  });
  assert.deepEqual(parseLoginCommand("kimi key sk-test"), {
    provider: "kimi",
    mode: "api-key",
    apiKey: "sk-test",
  });
  assert.deepEqual(
    parseLoginCommand("kimi key sk-test model k3 effort max context 524288"),
    {
      provider: "kimi",
      mode: "api-key",
      apiKey: "sk-test",
      model: "k3",
      reasoningEffort: "max",
      contextWindowTokens: 524_288,
    },
  );
  assert.deepEqual(
    parseLoginCommand("kimi device model k3-256k effort high context_window 262144"),
    {
      provider: "kimi",
      mode: "device",
      model: "k3-256k",
      reasoningEffort: "high",
      contextWindowTokens: 262_144,
    },
  );
  assert.deepEqual(parseLoginCommand("deepseek key sk-test model deepseek-reasoner"), {
    provider: "deepseek",
    mode: "api-key",
    apiKey: "sk-test",
    model: "deepseek-reasoner",
  });
  assert.deepEqual(
    parseLoginCommand(
      "compatible key sk-test name zhipu model local-model base_url http://127.0.0.1:11434/v1",
    ),
    {
      provider: "compatible",
      mode: "api-key",
      apiKey: "sk-test",
      alias: "zhipu",
      model: "local-model",
      baseURL: "http://127.0.0.1:11434/v1",
    },
  );
  assert.throws(
    () => parseLoginCommand("kimi key sk-test context not-a-number"),
    /context window must be an integer/,
  );
  assert.throws(
    () => parseLoginCommand("kimi device context 4096"),
    /context window must be an integer/,
  );
});

test("sealed compatible account reconfigures model and image input without re-entering its key", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-login-reconfigure-"));
  try {
    const store = new EncryptedFileCredentialStore(root);
    const auth = await AuthSession.create({
      config: resolveProviderConfig({
        provider: "compatible",
        accountAlias: "local",
        model: "before",
        baseURL: "https://models.example/v1",
        allowMissingCredential: true,
        environment: {},
      }),
      store,
    });
    await auth.loginApiKey("compatible", "sealed-secret", {
      alias: "local",
      model: "before",
      baseURL: "https://models.example/v1",
      imageInput: false,
    });
    const temporary = await auth.useAccount("compatible", "local", {
      model: "temporary",
      imageInput: true,
    }, "session");
    assert.equal(temporary.model, "temporary");
    assert.equal(temporary.imageInput, true);
    assert.equal((await store.get("compatible:local"))?.metadata?.model, "before");

    const saved = await auth.useAccount("compatible", "local", {
      model: "after",
      imageInput: true,
    });
    assert.equal(saved.model, "after");
    assert.equal(saved.imageInput, true);
    assert.equal((await store.get("compatible:local"))?.metadata?.model, "after");
    assert.equal((await store.get("compatible:local"))?.metadata?.imageInput, "true");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requestKimiDeviceAuthorization uses the public client id", async () => {
  const seen = [];
  const transport = {
    async postForm(url, body) {
      seen.push({ url, body });
      return {
        status: 200,
        json: {
          user_code: "CODE",
          device_code: "device",
          verification_uri_complete: "https://example.test",
          expires_in: 10,
          interval: 1,
        },
      };
    },
  };
  const auth = await requestKimiDeviceAuthorization(transport);
  assert.equal(auth.userCode, "CODE");
  assert.equal(seen[0].body.client_id, "17e5f671-d194-4dfb-9706-5516cb48c098");
  await assert.rejects(
    () => pollKimiDeviceToken(transport, { ...auth, interval: 0, expiresIn: 0 }, { sleep: async () => undefined }),
    /timed out|expired/,
  );
  assert.ok(createFetchKimiOAuthTransport());
});
