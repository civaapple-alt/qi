#!/usr/bin/env node

import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const requested = process.argv.slice(2);
if (requested.length === 0) {
  fail("Usage: npm run verify:focused -- tests/<name>.test.mjs [...]");
}

const tests = requested.map((value) => {
  const absolute = resolve(repositoryRoot, value);
  const relativePath = relative(repositoryRoot, absolute);
  if (
    relativePath.startsWith("..")
    || relativePath === ""
    || !relativePath.startsWith(`tests${sep}`)
    || !relativePath.endsWith(".test.mjs")
  ) {
    fail(`Focused verification accepts only tests/*.test.mjs paths: ${value}`);
  }
  if (!existsSync(absolute)) fail(`Focused test does not exist: ${value}`);
  return absolute;
});

run(process.execPath, [resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-b"]);
run(process.execPath, ["--test", ...tests]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
