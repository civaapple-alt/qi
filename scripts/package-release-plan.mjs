#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageReleasePlan } from "./lib/package-release.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const plan = await createPackageReleasePlan(options.root ?? defaultRoot);
const encoded = `${JSON.stringify(plan, null, 2)}\n`;
if (options.output) {
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded, "utf8");
}
process.stdout.write(encoded);
if (!plan.graphReady || (options.requireRegistryReady && plan.registry !== "ready")) process.exitCode = 1;

function parseArguments(args) {
  const options = { output: undefined, requireRegistryReady: false, root: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--require-registry-ready") {
      options.requireRegistryReady = true;
      continue;
    }
    if (argument === "--output" || argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new TypeError(`${argument} requires a path`);
      options[argument === "--output" ? "output" : "root"] = value;
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  return options;
}
