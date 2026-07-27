#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditSourceRelease } from "./lib/source-release.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const report = await auditSourceRelease(options.root ?? defaultRoot);
const encoded = `${JSON.stringify(report, null, 2)}\n`;

if (options.output) {
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded, "utf8");
}
process.stdout.write(encoded);

if (!report.engineeringReady || (options.requireSourceOpen && report.sourceOpen !== "ready")) {
  process.exitCode = 1;
}

function parseArguments(args) {
  const options = { output: undefined, requireSourceOpen: false, root: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--require-source-open") {
      options.requireSourceOpen = true;
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
