import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetProviderCatalog } from "@civaapple/qi-ai";
import {
  buildCompatibleModelFromFields,
  normalizeProviderCatalogId,
  parseCompatibleModelLines,
  parseTokenCount,
  writeCustomOpenAiCompatibleProvider,
} from "../apps/cli/dist/provider-catalog-write.js";

test.afterEach(() => {
  resetProviderCatalog();
});

test("parseTokenCount accepts integers and k/m suffixes", () => {
  assert.equal(parseTokenCount("128000", "context"), 128_000);
  assert.equal(parseTokenCount("256k", "context"), 256_000);
  assert.equal(parseTokenCount("32K", "output"), 32_000);
  assert.equal(parseTokenCount("1m", "context"), 1_000_000);
  assert.throws(() => parseTokenCount("abc", "context"), /k\/m suffix/);
});

test("buildCompatibleModelFromFields uses separate fields and defaults", () => {
  assert.deepEqual(
    buildCompatibleModelFromFields({
      modelId: "step-3.7-flash",
      contextWindowTokens: "256k",
      outputReserveTokens: "32k",
    }),
    { id: "step-3.7-flash", contextTokens: 256_000, outputReserveTokens: 32_000 },
  );
  assert.deepEqual(
    buildCompatibleModelFromFields({ modelId: "only-id" }),
    { id: "only-id", contextTokens: 128_000, outputReserveTokens: 16_000 },
  );
});

test("parseCompatibleModelLines accepts lines and semicolon separators", () => {
  const models = parseCompatibleModelLines(
    "MiMo-V2.5-Pro 1048576 65536; other-model\nthird 256000",
  );
  assert.deepEqual(models, [
    { id: "MiMo-V2.5-Pro", contextTokens: 1_048_576, outputReserveTokens: 65_536 },
    { id: "other-model", contextTokens: 128_000, outputReserveTokens: 16_000 },
    { id: "third", contextTokens: 256_000, outputReserveTokens: 16_000 },
  ]);
});

test("normalizeProviderCatalogId rejects built-in ids", () => {
  assert.equal(normalizeProviderCatalogId("Xiaomi"), "xiaomi");
  assert.throws(() => normalizeProviderCatalogId("compatible"), /conflicts with a built-in/);
});

test("writeCustomOpenAiCompatibleProvider writes TOML and installs profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qi-providers-"));
  const written = await writeCustomOpenAiCompatibleProvider({
    name: "xiaomi",
    baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
    directory,
    wireApi: "chat.completions",
    chatThinking: "enable_thinking_and_effort",
    chatOutputTokenField: "max_tokens",
    models: [
      { id: "MiMo-V2.5-Pro", contextTokens: 1_048_576, outputReserveTokens: 65_536 },
      { id: "MiMo-Fast", contextTokens: 256_000, outputReserveTokens: 16_000 },
    ],
  });
  assert.equal(written.providerId, "xiaomi");
  assert.equal(written.path, join(directory, "xiaomi.toml"));
  const text = await readFile(written.path, "utf8");
  assert.match(text, /id = "xiaomi"/);
  assert.match(text, /wire_api = "chat\.completions"/);
  assert.match(text, /chat_thinking = "enable_thinking_and_effort"/);
  assert.match(text, /id = "MiMo-V2\.5-Pro"/);
  assert.match(text, /context_tokens = 1048576/);
  assert.match(text, /id = "MiMo-Fast"/);
  assert.equal(written.profile.defaultModel, "MiMo-V2.5-Pro");
  assert.equal(written.profile.wireApi, "chat.completions");
  assert.equal(written.profile.models?.length, 2);
});

test("writeCustomOpenAiCompatibleProvider can target Responses wire", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qi-providers-"));
  const written = await writeCustomOpenAiCompatibleProvider({
    name: "acme-responses",
    baseURL: "https://api.example.com/v1",
    directory,
    wireApi: "responses",
    responsesThinking: "thinking_type_and_reasoning_effort",
    models: [{ id: "acme-1", contextTokens: 128_000, outputReserveTokens: 16_000 }],
  });
  const text = await readFile(written.path, "utf8");
  assert.match(text, /wire_api = "responses"/);
  assert.match(text, /responses_thinking = "thinking_type_and_reasoning_effort"/);
  assert.match(text, /responses = true/);
  assert.equal(written.profile.wireApi, "responses");
});
