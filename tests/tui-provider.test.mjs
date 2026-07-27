import test from "node:test";
import assert from "node:assert/strict";
import { renderEvent, resolveProviderConfig } from "../apps/cli/dist/index.js";

test("TUI selects xAI from its provider-specific environment", () => {
  const config = resolveProviderConfig({
    environment: {
      XAI_API_KEY: "xai-secret",
      XAI_BASE_URL: "https://api.x.ai/v1/",
      XAI_MODEL: "grok-test",
    },
  });
  assert.equal(config.provider, "xai");
  assert.equal(config.model, "grok-test");
  assert.equal(config.apiKey, "xai-secret");
  assert.equal(config.baseURL, "https://api.x.ai/v1");
  assert.equal(config.endpointTrust, "official");
  assert.equal(config.wireApi, "responses");
  assert.equal(config.authStatus, "ready");
});

test("TUI uses the official xAI endpoint when XAI_BASE_URL is unset", () => {
  const config = resolveProviderConfig({
    environment: { XAI_API_KEY: "xai-secret", XAI_MODEL: "grok-test" },
  });
  assert.equal(config.baseURL, "https://api.x.ai/v1");
  assert.equal(config.endpointTrust, "official");
});

test("TUI provider config uses CLI then environment then user defaults", () => {
  const defaults = {
    provider: "xai",
    model: "grok-config",
    baseURL: "https://api.x.ai/v1",
  };
  const fromDefaults = resolveProviderConfig({ defaults, environment: { XAI_API_KEY: "xai-secret" } });
  assert.equal(fromDefaults.provider, "xai");
  assert.equal(fromDefaults.model, "grok-config");
  assert.equal(fromDefaults.apiKey, "xai-secret");
  const fromCli = resolveProviderConfig({
    model: "grok-cli",
    baseURL: "https://api.x.ai/v1",
    defaults,
    environment: {
      XAI_API_KEY: "xai-secret",
      QI_MODEL: "grok-env",
      XAI_BASE_URL: "https://env.x.ai/v1",
    },
  });
  assert.equal(fromCli.model, "grok-cli");
  assert.equal(fromCli.baseURL, "https://api.x.ai/v1");
});

test("TUI rejects an xAI key aimed at the OpenAI endpoint", () => {
  assert.throws(
    () =>
      resolveProviderConfig({
        environment: {
          XAI_API_KEY: "xai-secret",
          XAI_BASE_URL: "https://api.openai.com/v1",
          XAI_MODEL: "grok-test",
        },
      }),
    /XAI_BASE_URL points to api\.openai\.com/,
  );
});

test("TUI preserves the OpenAI default when only OPENAI_API_KEY is set", () => {
  const config = resolveProviderConfig({ environment: { OPENAI_API_KEY: "openai-secret" } });
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-5.4-mini");
  assert.equal(config.apiKey, "openai-secret");
  assert.equal(config.endpointTrust, "official");
  assert.equal(config.baseURL, "https://api.openai.com/v1");
  assert.equal(config.wireApi, "responses");
});

test("TUI refuses official credentials on custom endpoints and rejects URL userinfo", () => {
  assert.throws(
    () =>
      resolveProviderConfig({
        baseURL: "https://proxy.example/v1",
        environment: { OPENAI_API_KEY: "openai-secret" },
      }),
    /QI_API_KEY/,
  );
  const custom = resolveProviderConfig({
    provider: "openai",
    baseURL: "https://proxy.example/v1",
    environment: { QI_API_KEY: "custom-secret" },
  });
  assert.equal(custom.apiKey, "custom-secret");
  assert.equal(custom.baseURL, "https://proxy.example/v1");
  assert.equal(custom.endpointTrust, "custom");
  assert.throws(
    () =>
      resolveProviderConfig({
        environment: {
          OPENAI_API_KEY: "openai-secret",
          OPENAI_BASE_URL: "https://user:pass@api.openai.com/v1",
        },
      }),
    /must not embed credentials/,
  );
});

test("TUI requires an explicit provider when both credentials are present", () => {
  const environment = {
    OPENAI_API_KEY: "openai-secret",
    XAI_API_KEY: "xai-secret",
    XAI_MODEL: "grok-test",
  };
  assert.throws(
    () => resolveProviderConfig({ environment }),
    /Multiple provider API keys are set/,
  );
  assert.equal(resolveProviderConfig({ provider: "xai", environment }).provider, "xai");
  assert.equal(resolveProviderConfig({ provider: "openai", environment }).provider, "openai");
});

test("TUI uses xAI profile defaultModel when XAI_MODEL is unset", () => {
  const config = resolveProviderConfig({ environment: { XAI_API_KEY: "xai-secret" } });
  assert.equal(config.provider, "xai");
  assert.equal(config.model, "grok-4.5");
});

test("TUI renders an inline model transport diagnostic", () => {
  const line = renderEvent({
    type: "run.failed",
    data: {
      runId: "run_transport_failure_001",
      code: "MODEL_TRANSPORT",
      diagnosticRef: "diagnostic:inline:Error%3A%20400%20metadata%20unsupported",
    },
  });
  assert.match(line, /MODEL_TRANSPORT · Error: 400 metadata unsupported/);
});
