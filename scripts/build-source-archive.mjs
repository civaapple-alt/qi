#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditSourceRelease, run } from "./lib/source-release.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const root = resolve(options.root ?? defaultRoot);
const audit = await auditSourceRelease(root);

if (audit.archive !== "ready") {
  process.stdout.write(`${JSON.stringify({
    type: "qi.source-release-archive",
    schemaVersion: 1,
    status: "blocked",
    release: audit.release,
    blockers: audit.blockers,
  }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  const outputDirectory = resolve(options.outputDirectory ?? join(root, ".release"));
  const filename = `qi-${audit.release}-source.tar.gz`;
  const archive = join(outputDirectory, filename);
  const checksum = `${archive}.sha256`;
  const temporaryArchive = join(outputDirectory, `.${filename}.${process.pid}.tmp`);
  const temporaryChecksum = `${temporaryArchive}.sha256`;
  await assertAbsent(archive);
  await assertAbsent(checksum);
  await mkdir(outputDirectory, { recursive: true });
  let archiveCreated = false;

  try {
    await run(
      "git",
      ["archive", "--format=tar.gz", `--prefix=qi-${audit.release}/`, `--output=${temporaryArchive}`, "HEAD"],
      root,
    );
    const bytes = await readFile(temporaryArchive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(temporaryChecksum, `${sha256}  ${basename(archive)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryArchive, archive);
    archiveCreated = true;
    await rename(temporaryChecksum, checksum);
    process.stdout.write(`${JSON.stringify({
      type: "qi.source-release-archive",
      schemaVersion: 1,
      status: "pass",
      release: audit.release,
      commit: (await run("git", ["rev-parse", "HEAD"], root)).stdout.trim(),
      archive,
      checksum,
      bytes: bytes.byteLength,
      sha256,
    }, null, 2)}\n`);
  } catch (error) {
    await rm(temporaryArchive, { force: true });
    await rm(temporaryChecksum, { force: true });
    if (archiveCreated) await rm(archive, { force: true });
    throw error;
  }
}

function parseArguments(args) {
  const options = { outputDirectory: undefined, root: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output-dir" || argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new TypeError(`${argument} requires a path`);
      options[argument === "--output-dir" ? "outputDirectory" : "root"] = value;
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  return options;
}

async function assertAbsent(path) {
  try {
    await access(path, constants.F_OK);
    throw new Error(`Refusing to overwrite existing release artifact: ${path}`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}
