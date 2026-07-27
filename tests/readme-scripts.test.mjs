import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("README documents every supported root package script", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const readme = await readFile(join(root, "README.md"), "utf8");
  for (const name of Object.keys(manifest.scripts).sort()) {
    const command = name === "test" ? "npm test" : `npm run ${name}`;
    assert.ok(readme.includes(`\`${command}\``), `README is missing package script: ${name}`);
  }
});
