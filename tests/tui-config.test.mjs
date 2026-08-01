import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { getProviderProfile, resetProviderCatalog } from "@civaapple/qi-ai";
import {
  defaultUserConfigPath,
  ensureUserShellConfig,
  findCompatibleEndpoint,
  loadUserConfig,
  persistActiveCompatible,
  persistUserLanguage,
  persistUserMaxActionsPerStep,
  persistUserMaxSteps,
  persistUserProviderDefaults,
  persistUserShell,
  persistUserTheme,
  persistUserTimelineDensity,
  parseTuiCliArguments,
  resolveCapabilities,
  resolveLanguage,
  resolveTheme,
  resolveTimelineDensity,
  saveUserConfig,
  supportedEffortsForModel,
} from "../apps/cli/dist/index.js";
import { writeCustomOpenAiCompatibleProvider } from "../apps/cli/dist/provider-catalog-write.js";

test("user config loads strict provider defaults and persistent capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
provider = "xai"
model = "grok-config"
base_url = "https://api.x.ai/v1"
context_window_tokens = 256000
max_steps = 32

[capabilities]
write = true
verify = true
network = true
execute = false
background = true

[shell]
default = "pwsh"
allowed = ["direct", "pwsh"]

[memory]
enabled = false
auto_accept_project = false
`);
    const loaded = await loadUserConfig(path);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.path, path);
    assert.deepEqual(loaded.config, {
      version: 1,
      provider: "xai",
      model: "grok-config",
      baseURL: "https://api.x.ai/v1",
      contextWindowTokens: 256000,
      maxSteps: 32,
      capabilities: { write: true, verify: true, network: true, execute: false, background: true },
      shell: { default: "pwsh", allowed: ["direct", "pwsh"] },
      memory: { enabled: false, autoAcceptProject: false },
    });
    assert.deepEqual(resolveCapabilities(loaded.config.capabilities), {
      allowWrite: true,
      allowVerify: true,
      allowNetwork: true,
      allowExecute: false,
      allowBackground: true,
      allowDelegate: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistUserProviderDefaults merges provider routing into existing user config.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-persist-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
provider = "xai"
model = "grok-config"
base_url = "https://api.x.ai/v1"

[capabilities]
write = true
execute = true

[shell]
default = "direct"
allowed = ["direct", "pwsh"]

[memory]
enabled = true
auto_accept_project = false
`);
    const saved = await persistUserProviderDefaults({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseURL: "https://api.deepseek.com/v1",
      accountAlias: "default",
    }, path);
    assert.equal(saved.path, path);
    assert.equal(saved.config.provider, "deepseek");
    assert.equal(saved.config.model, "deepseek-v4-pro");
    assert.equal(saved.config.baseURL, "https://api.deepseek.com/v1");
    assert.deepEqual(saved.config.capabilities, { write: true, execute: true });
    assert.deepEqual(saved.config.shell, { default: "direct", allowed: ["direct", "pwsh"] });
    assert.deepEqual(saved.config.memory, { enabled: true, autoAcceptProject: false });
    const reloaded = await loadUserConfig(path);
    assert.equal(reloaded.config.provider, "deepseek");
    assert.equal(reloaded.config.model, "deepseek-v4-pro");
    assert.deepEqual(reloaded.config.memory, { enabled: true, autoAcceptProject: false });
    const body = await readFile(path, "utf8");
    assert.match(body, /provider = "deepseek"/);
    assert.doesNotMatch(body, /api_key|secret/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi model defaults resolve model windows and normalized reasoning effort", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-kimi-model-config-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
provider = "kimi"
model = "k3"
reasoning_effort = "xhigh"
`);
    const loaded = await loadUserConfig(path);
    assert.equal(loaded.config.reasoningEffort, "max");
    const persisted = await persistUserProviderDefaults({
      provider: "kimi",
      model: "k3-256k",
      baseURL: "https://api.kimi.com/coding/v1",
      reasoningEffort: "low",
      contextWindowTokens: 300_000,
    }, path);
    assert.equal(persisted.config.model, "k3-256k");
    assert.equal(persisted.config.reasoningEffort, "low");
    assert.equal(persisted.config.contextWindowTokens, 300_000);

    const savedBody = await readFile(path, "utf8");
    assert.match(savedBody, /model = "k3-256k"/);
    assert.match(savedBody, /reasoning_effort = "low"/);
    assert.match(savedBody, /context_window_tokens = 300000/);

    await writeFile(path, `
version = 1
provider = "kimi"
model = "k3"
reasoning_effort = "max"
`);
    const k3 = await parseTuiCliArguments(
      ["--workspace", root, "--config", path],
      { environment: { QI_HOME: join(root, "state") } },
    );
    assert.equal(k3.kind, "run");
    assert.equal(k3.options.provider.model, "k3");
    assert.equal(k3.options.provider.reasoningEffort, "max");
    assert.equal(k3.options.contextWindowTokens, 1_048_576);

    const k3Compact = await parseTuiCliArguments(
      ["--workspace", root, "--config", path, "--model", "k3-256k", "--effort", "medium"],
      { environment: { QI_HOME: join(root, "state") } },
    );
    assert.equal(k3Compact.kind, "run");
    assert.equal(k3Compact.options.provider.reasoningEffort, "medium");
    assert.equal(k3Compact.options.contextWindowTokens, 262_144);

    await writeFile(path, `
version = 1
provider = "kimi"
model = "k3"
reasoning_effort = "high"
context_window_tokens = 524288
`);
    const overridden = await parseTuiCliArguments(
      ["--workspace", root, "--config", path],
      { environment: { QI_HOME: join(root, "state") } },
    );
    assert.equal(overridden.kind, "run");
    assert.equal(overridden.options.contextWindowTokens, 524_288);
    assert.equal(overridden.options.provider.reasoningEffort, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user config is optional, strict, and cannot contain an API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-invalid-"));
  try {
    const missing = await loadUserConfig(join(root, "missing.toml"));
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.config, { version: 1 });

    const invalid = join(root, "invalid.toml");
    await writeFile(invalid, 'provider = "xai"\napi_key = "must-not-live-here"\n');
    await assert.rejects(loadUserConfig(invalid), /unknown keys: api_key/);

    const incomplete = join(root, "incomplete.toml");
    await writeFile(incomplete, 'model = "grok-without-provider"\n');
    await assert.rejects(loadUserConfig(incomplete), /provider is required/);

    const invalidContext = join(root, "invalid-context.toml");
    await writeFile(invalidContext, "context_window_tokens = 4096\n");
    await assert.rejects(loadUserConfig(invalidContext), /integer between 8192 and 2000000/);

    const invalidSteps = join(root, "invalid-steps.toml");
    await writeFile(invalidSteps, "max_steps = 1001\n");
    await assert.rejects(loadUserConfig(invalidSteps), /integer between 8 and 1000/);

    const invalidEffort = join(root, "invalid-effort.toml");
    await writeFile(invalidEffort, 'provider = "kimi"\nreasoning_effort = "extreme"\n');
    await assert.rejects(loadUserConfig(invalidEffort), /Unsupported reasoning effort/);

    const unknownProvider = join(root, "unknown-provider.toml");
    await writeFile(unknownProvider, 'provider = "not-a-catalog-provider"\nmodel = "x"\n');
    await assert.rejects(loadUserConfig(unknownProvider), /known catalog id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user config accepts catalog overlay providers and their reasoning_effort", async () => {
  const providersDir = await mkdtemp(join(tmpdir(), "qi-providers-cfg-"));
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-overlay-"));
  const path = join(root, "config.toml");
  try {
    await writeCustomOpenAiCompatibleProvider({
      name: "stepfun",
      baseURL: "https://api.stepfun.com/step_plan/v1",
      directory: providersDir,
      wireApi: "chat.completions",
      chatThinking: "reasoning_effort",
      chatOutputTokenField: "max_tokens",
      models: [{ id: "step-3.7-flash", contextTokens: 256_000, outputReserveTokens: 32_000 }],
    });
    assert.ok(getProviderProfile("stepfun"));

    const saved = await persistUserProviderDefaults({
      provider: "stepfun",
      model: "step-3.7-flash",
      accountAlias: "default",
      baseURL: "https://api.stepfun.com/step_plan/v1",
      reasoningEffort: "high",
      contextWindowTokens: 256_000,
      outputReserveTokens: 32_000,
    }, path);
    assert.equal(saved.config.provider, "stepfun");
    assert.equal(saved.config.model, "step-3.7-flash");
    assert.equal(saved.config.reasoningEffort, "high");

    const loaded = await loadUserConfig(path);
    assert.equal(loaded.config.provider, "stepfun");
    assert.equal(loaded.config.reasoningEffort, "high");
    const body = await readFile(path, "utf8");
    assert.match(body, /provider = "stepfun"/);
    assert.match(body, /reasoning_effort = "high"/);
  } finally {
    resetProviderCatalog();
    await rm(providersDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("user config rejects invalid shell profile settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-shell-config-invalid-"));
  try {
    const unknown = join(root, "unknown.toml");
    await writeFile(unknown, `
[shell]
default = "zsh"
allowed = ["direct"]
`);
    await assert.rejects(loadUserConfig(unknown), /shell\.default/);

    const mismatch = join(root, "mismatch.toml");
    await writeFile(mismatch, `
[shell]
default = "bash"
allowed = ["direct", "pwsh"]
`);
    await assert.rejects(loadUserConfig(mismatch), /listed in shell\.allowed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user config language defaults to zh and persists across provider writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-language-"));
  const path = join(root, "config.toml");
  try {
    const missing = await loadUserConfig(join(root, "missing.toml"));
    assert.equal(resolveLanguage(missing.config), "zh");

    await writeFile(path, `
version = 1
language = "en"
provider = "xai"
model = "grok-config"
`);
    const loaded = await loadUserConfig(path);
    assert.equal(loaded.config.language, "en");
    assert.equal(resolveLanguage(loaded.config), "en");

    await persistUserProviderDefaults({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    }, path);
    const afterProvider = await loadUserConfig(path);
    assert.equal(afterProvider.config.language, "en");
    assert.equal(afterProvider.config.provider, "deepseek");

    await persistUserLanguage("zh", path);
    const afterLanguage = await loadUserConfig(path);
    assert.equal(afterLanguage.config.language, "zh");
    assert.equal(afterLanguage.config.provider, "deepseek");
    const body = await readFile(path, "utf8");
    assert.match(body, /language = "zh"/);

    const invalid = join(root, "invalid-language.toml");
    await writeFile(invalid, 'language = "fr"\n');
    await assert.rejects(loadUserConfig(invalid), /language must be one of/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user config theme persists and is not clobbered by provider writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-theme-"));
  const path = join(root, "config.toml");
  try {
    assert.equal(resolveTheme({ version: 1 }), "auto");
    await writeFile(path, `
version = 1
theme = "light"
provider = "xai"
model = "grok-config"
`);
    const loaded = await loadUserConfig(path);
    assert.equal(loaded.config.theme, "light");
    assert.equal(resolveTheme(loaded.config), "light");

    await persistUserProviderDefaults({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    }, path);
    const afterProvider = await loadUserConfig(path);
    assert.equal(afterProvider.config.theme, "light");

    await persistUserTheme("dark", path);
    const afterTheme = await loadUserConfig(path);
    assert.equal(afterTheme.config.theme, "dark");
    assert.equal(afterTheme.config.provider, "deepseek");

    const invalid = join(root, "invalid-theme.toml");
    await writeFile(invalid, 'theme = "solarized"\n');
    await assert.rejects(loadUserConfig(invalid), /theme must be one of/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeline density defaults to standard and persists under ui without Session facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-density-"));
  const path = join(root, "config.toml");
  try {
    assert.equal(resolveTimelineDensity({ version: 1 }), "standard");
    await writeFile(path, `
version = 1
provider = "xai"
model = "grok-config"

[ui]
timeline_density = "compact"
`);
    const loaded = await loadUserConfig(path);
    assert.equal(resolveTimelineDensity(loaded.config), "compact");

    await persistUserTimelineDensity("diagnostic", path);
    const saved = await loadUserConfig(path);
    assert.equal(saved.config.ui.timelineDensity, "diagnostic");
    assert.equal(saved.config.provider, "xai");
    assert.match(await readFile(path, "utf8"), /\[ui\]\s+timeline_density = "diagnostic"/);

    const invalid = join(root, "invalid-density.toml");
    await writeFile(invalid, "[ui]\ntimeline_density = \"dense\"\n");
    await assert.rejects(loadUserConfig(invalid), /timeline_density must be one of/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image preprocessing and compatible image opt-in round-trip through user config", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-image-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
provider = "compatible"
model = "vision-custom"
account_alias = "vision"
base_url = "https://vision.example/v1"

[image]
max_edge_px = 1800
read_byte_budget = 300000

[[compatible]]
name = "vision"
base_url = "https://vision.example/v1"
model = "vision-custom"
image_input = true
`);
    const loaded = await loadUserConfig(path);
    assert.deepEqual(loaded.config.image, { maxEdgePx: 1800, readByteBudget: 300000 });
    assert.equal(loaded.config.compatible[0].imageInput, true);
    await saveUserConfig(path, loaded.config);
    const saved = await loadUserConfig(path);
    assert.equal(saved.config.compatible[0].imageInput, true);
    assert.match(await readFile(path, "utf8"), /image_input = true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compatible catalog upserts multiple endpoints and can switch active", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-compatible-catalog-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
language = "zh"
`);
    await persistUserProviderDefaults({
      provider: "compatible",
      accountAlias: "qianwenai",
      model: "qwen-plus",
      baseURL: "https://dashscope.aliyun.com/compatible-mode/v1",
    }, path);
    await persistUserProviderDefaults({
      provider: "compatible",
      accountAlias: "zhipu",
      model: "glm-4",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
    }, path);
    const loaded = await loadUserConfig(path);
    assert.equal(loaded.config.provider, "compatible");
    assert.equal(loaded.config.accountAlias, "zhipu");
    assert.equal(loaded.config.model, "glm-4");
    assert.equal(loaded.config.compatible?.length, 2);
    assert.ok(findCompatibleEndpoint(loaded.config, "qianwenai"));
    assert.ok(findCompatibleEndpoint(loaded.config, "zhipu"));

    const switched = await persistActiveCompatible("qianwenai", path);
    assert.equal(switched.config.accountAlias, "qianwenai");
    assert.equal(switched.config.model, "qwen-plus");
    assert.equal(switched.config.baseURL, "https://dashscope.aliyun.com/compatible-mode/v1");
    assert.equal(switched.config.compatible?.length, 2);
    assert.equal(switched.config.language, "zh");

    const body = await readFile(path, "utf8");
    assert.match(body, /compatible/);
    assert.match(body, /qianwenai/);
    assert.match(body, /zhipu/);
    assert.doesNotMatch(body, /api_key|secret/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capability overrides can narrow config or enter safe mode", () => {
  const configured = { write: true, verify: true, network: true, execute: true, background: true };
  assert.deepEqual(resolveCapabilities(configured, { network: false, execute: false }), {
    allowWrite: true,
    allowVerify: true,
    allowNetwork: false,
    allowExecute: false,
    allowBackground: true,
    allowDelegate: false,
  });
  assert.deepEqual(resolveCapabilities(configured, { safe: true, write: true }), {
    allowWrite: false,
    allowVerify: false,
    allowNetwork: false,
    allowExecute: false,
    allowBackground: false,
    allowDelegate: false,
  });
});

test("default config path supports the user home and explicit environment overrides", () => {
  const home = join(tmpdir(), "qi-home");
  const qiHome = join(tmpdir(), "qi-state");
  const explicit = join(tmpdir(), "qi-config", "custom.toml");
  assert.equal(
    defaultUserConfigPath({}, home),
    join(home, ".qi", "config.toml"),
  );
  assert.equal(
    defaultUserConfigPath({ QI_HOME: qiHome }, "ignored"),
    join(qiHome, "config.toml"),
  );
  assert.equal(
    defaultUserConfigPath({ QI_CONFIG: explicit }, "ignored"),
    explicit,
  );
});

test("TUI applies user config and --safe overrides persistent capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-cli-"));
  const config = join(root, "config.toml");
  try {
    await writeFile(config, `
provider = "xai"
model = "grok-config"
base_url = "https://api.x.ai/v1"
context_window_tokens = 256000
[capabilities]
write = true
network = true
execute = true
`);
    const configured = await launchTui(root, config, []);
    assert.match(configured.stdout, /model xai\/grok-config via https:\/\/api\.x\.ai\/v1/);
    assert.match(configured.stdout, /context 240000 prompt \+ 16000 output reserve \/ 256000 window/);
    assert.match(configured.stdout, /Permissions enabled: read, write, network, execute/);
    assert.match(configured.stdout, /Permissions disabled: verify, background, delegate/);
    assert.match(configured.stdout, new RegExp(`config ${escapeRegex(config)}`));

    const safe = await launchTui(root, config, ["--safe"]);
    assert.match(safe.stdout, /Permissions enabled: read\r?\n/);
    assert.match(safe.stdout, /Permissions disabled: write, verify, network, execute, background, delegate/);

    const narrowed = await launchTui(root, config, ["--no-network", "--no-execute"]);
    assert.match(narrowed.stdout, /Permissions enabled: read, write\r?\n/);
    assert.match(narrowed.stdout, /Permissions disabled: verify, network, execute, background, delegate/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-state`, { recursive: true, force: true });
  }
});

function launchTui(workspace, config, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "apps/cli/dist/main.js",
      "--workspace", workspace,
      "--config", config,
      ...extraArgs,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XAI_API_KEY: "test-key",
        XAI_MODEL: "",
        XAI_BASE_URL: "",
        QI_PROVIDER: "",
        QI_MODEL: "",
        OPENAI_API_KEY: "",
        QI_HOME: `${workspace}-state`,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`TUI config fixture timed out: ${stderr}`));
    }, 10_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`TUI exited ${code}: ${stderr}`));
    });
    child.stdin.end("/quit\n");
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("persistUserMaxSteps writes max_steps and rejects out-of-range values", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-config-max-steps-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
provider = "xai"
model = "grok-config"
max_steps = 32
`);
    const saved = await persistUserMaxSteps(48, path);
    assert.equal(saved.config.maxSteps, 48);
    const reloaded = await loadUserConfig(path);
    assert.equal(reloaded.config.maxSteps, 48);
    assert.match(await readFile(path, "utf8"), /max_steps = 48/);

    await assert.rejects(() => persistUserMaxSteps(7, path), /integer from 8 to 1000/);
    await assert.rejects(() => persistUserMaxSteps(1001, path), /integer from 8 to 1000/);
    const high = await persistUserMaxSteps(1000, path);
    assert.equal(high.config.maxSteps, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output_reserve_tokens loads from user config and persists via provider defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-output-reserve-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
provider = "deepseek"
model = "deepseek-v4-flash"
output_reserve_tokens = 65536
`);
    const loaded = await loadUserConfig(path);
    assert.equal(loaded.config.outputReserveTokens, 65_536);
    const parsed = await parseTuiCliArguments(
      ["--workspace", root, "--config", path],
      { environment: { QI_HOME: join(root, "state") } },
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.outputReserveTokensPreferred, 65_536);
    assert.equal(parsed.options.outputReserveTokens, 65_536);

    const saved = await persistUserProviderDefaults({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      outputReserveTokens: 32_768,
    }, path);
    assert.equal(saved.config.outputReserveTokens, 32_768);
    assert.match(await readFile(path, "utf8"), /output_reserve_tokens = 32768/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistUserMaxActionsPerStep writes max_actions_per_step and rejects out-of-range values", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-max-actions-"));
  const path = join(root, "config.toml");
  try {
    await writeFile(path, `
version = 1
provider = "xai"
model = "grok-config"
max_actions_per_step = 4
`);
    const saved = await persistUserMaxActionsPerStep(8, path);
    assert.equal(saved.config.maxActionsPerStep, 8);
    const reloaded = await loadUserConfig(path);
    assert.equal(reloaded.config.maxActionsPerStep, 8);
    assert.match(await readFile(path, "utf8"), /max_actions_per_step = 8/);

    await assert.rejects(() => persistUserMaxActionsPerStep(0, path), /integer from 1 to 32/);
    await assert.rejects(() => persistUserMaxActionsPerStep(33, path), /integer from 1 to 32/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supportedEffortsForModel advertises Kimi K3 thinking efforts from provider profile", () => {
  const kimi = getProviderProfile("kimi");
  assert.ok(kimi);
  assert.deepEqual(supportedEffortsForModel(kimi, "k3"), ["low", "high", "max"]);
  assert.deepEqual(supportedEffortsForModel(kimi, "kimi-for-coding"), []);
});

test("supportedEffortsForModel advertises Volcengine Agent Plan thinking efforts", () => {
  const ark = getProviderProfile("volcengine-agent-plan");
  assert.ok(ark);
  assert.deepEqual(supportedEffortsForModel(ark, "glm-latest"), ["low", "medium", "high"]);
  assert.deepEqual(supportedEffortsForModel(ark, "minimax-m2.7"), []);
});

test("Volcengine Agent Plan persists reasoning_effort in user config", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-ark-plan-config-"));
  const path = join(root, "config.toml");
  try {
    const saved = await persistUserProviderDefaults({
      provider: "volcengine-agent-plan",
      model: "glm-latest",
      baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
      reasoningEffort: "medium",
      outputReserveTokens: 1024,
    }, path);
    assert.equal(saved.config.provider, "volcengine-agent-plan");
    assert.equal(saved.config.reasoningEffort, "medium");
    assert.equal(saved.config.outputReserveTokens, 1024);
    const body = await readFile(path, "utf8");
    assert.match(body, /provider = "volcengine-agent-plan"/);
    assert.match(body, /reasoning_effort = "medium"/);
    assert.match(body, /output_reserve_tokens = 1024/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureUserShellConfig writes detected profiles once and preserves later edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-user-shell-bootstrap-"));
  const path = join(root, "config.toml");
  const workspace = join(root, "ws");
  try {
    await writeFile(join(root, ".keep"), "");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    const first = await ensureUserShellConfig(workspace, path);
    assert.equal(first.exists, true);
    assert.ok(first.config.shell?.allowed?.includes("direct"));
    const raw = await readFile(path, "utf8");
    assert.match(raw, /\[shell\]/);
    assert.match(raw, /allowed/);

    await persistUserShell({ default: "direct", allowed: ["direct"] }, path);
    const second = await ensureUserShellConfig(workspace, path);
    assert.deepEqual(second.config.shell, { default: "direct", allowed: ["direct"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
