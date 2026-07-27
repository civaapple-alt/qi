#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const cliManifest = JSON.parse(await readFile(join(root, "apps", "cli", "package.json"), "utf8"));
const startedAt = new Date();
const started = performance.now();
const checks = [];
const temporaryRoot = await mkdtemp(join(tmpdir(), "qi-preview-acceptance-"));
const prefix = join(temporaryRoot, "prefix");
const workspace = join(temporaryRoot, "workspace");
const dataRoot = join(temporaryRoot, "data");
const qiHome = join(temporaryRoot, "home");
const tarball = options.tarball
  ? resolve(root, options.tarball)
  : join(root, ".cli-package", `${npmPackFilenameBase(cliManifest.name)}-${cliManifest.version}.tgz`);
let failure;
let kept = false;

try {
  await mkdir(prefix, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(qiHome, { recursive: true });

  if (!options.skipBuild) {
    await checkedRun(
      "pack",
      process.execPath,
      ["scripts/build-cli-package.mjs", "--pack"],
      { cwd: root, timeoutMs: 120_000 },
      checks,
    );
  }

  const tarballBytes = await readFile(tarball);
  checks.push({
    id: "tarball",
    status: "pass",
    evidence: {
      bytes: tarballBytes.byteLength,
      sha256: createHash("sha256").update(tarballBytes).digest("hex"),
    },
  });

  const childEnvironment = credentialFreeEnvironment({
    ...process.env,
    QI_HOME: qiHome,
    npm_config_cache: join(temporaryRoot, "npm-cache"),
  });
  await checkedRun(
    "install",
    "npm",
    ["install", "--global", "--prefix", prefix, tarball],
    { cwd: workspace, env: childEnvironment, timeoutMs: 120_000 },
    checks,
  );

  const qiCommand = process.platform === "win32"
    ? join(prefix, "qi.cmd")
    : join(prefix, "bin", "qi");
  const version = await checkedRun(
    "version",
    qiCommand,
    ["--version"],
    { cwd: workspace, env: childEnvironment, timeoutMs: 15_000 },
    checks,
  );
  if (version.stdout.trim() !== `qi ${cliManifest.version}`) {
    throw new Error(`Installed CLI reported unexpected version: ${version.stdout.trim()}`);
  }

  const help = await checkedRun(
    "help",
    qiCommand,
    ["--help"],
    { cwd: workspace, env: childEnvironment, timeoutMs: 15_000 },
    checks,
  );
  if (!help.stdout.includes("qi [WORKSPACE]") || !help.stdout.includes("--safe")) {
    throw new Error("Installed CLI help is missing its workspace or safe-mode contract");
  }

  await checkedRun(
    "git-init",
    "git",
    ["init", "--quiet"],
    { cwd: workspace, env: childEnvironment, timeoutMs: 15_000 },
    checks,
  );
  const launch = await checkedRun(
    "safe-startup",
    qiCommand,
    [workspace, "--data", dataRoot, "--no-config", "--safe"],
    {
      cwd: workspace,
      env: childEnvironment,
      input: "/quit\n",
      timeoutMs: 20_000,
    },
    checks,
  );
  const launchCheck = checks.find((check) => check.id === "safe-startup");
  launchCheck.evidence = {
    arguments: ["<workspace>", "--data", "<dataRoot>", "--no-config", "--safe"],
    output: bounded(`${launch.stdout}\n${launch.stderr}`.replaceAll(temporaryRoot, "<temporaryRoot>"), 1_000),
  };
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  kept = options.keep;
  if (!kept) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
      checks.push({ id: "cleanup", status: "pass" });
    } catch (error) {
      checks.push({
        id: "cleanup",
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      });
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
}

const completedAt = new Date();
const tarballCheck = checks.find((check) => check.id === "tarball");
const report = {
  schemaVersion: 1,
  kind: "qi.preview.acceptance",
  status: failure ? "fail" : "pass",
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  durationMs: Math.round(performance.now() - started),
  package: {
    name: cliManifest.name,
    version: cliManifest.version,
    tarball: basename(tarball),
    ...(tarballCheck?.evidence ?? {}),
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    credentialFree: true,
    safeMode: true,
  },
  temporaryState: kept ? { retained: true, path: temporaryRoot } : { retained: false },
  checks,
  ...(failure ? { error: failure.message } : {}),
};
const encoded = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  const output = resolve(root, options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded, "utf8");
}
process.stdout.write(encoded);
if (failure) process.exitCode = 1;

function parseArguments(args) {
  const parsed = { keep: false, skipBuild: false, output: undefined, tarball: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (argument === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (argument === "--output") {
      const output = args[index + 1];
      if (!output) throw new TypeError("--output requires a path");
      parsed.output = output;
      index += 1;
      continue;
    }
    if (argument === "--tarball") {
      const tarball = args[index + 1];
      if (!tarball) throw new TypeError("--tarball requires a path");
      parsed.tarball = tarball;
      parsed.skipBuild = true;
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function npmPackFilenameBase(packageName) {
  return packageName.startsWith("@")
    ? packageName.slice(1).replaceAll("/", "-")
    : packageName;
}

function credentialFreeEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) => {
      if (value === undefined) return false;
      return !/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|NPM[_-]?TOKEN|_SECRET)$/i.test(name);
    }),
  );
}

async function checkedRun(id, command, args, optionsForRun, targetChecks) {
  const startedRun = performance.now();
  const result = await run(command, args, optionsForRun);
  const check = {
    id,
    status: result.code === 0 ? "pass" : "fail",
    durationMs: Math.round(performance.now() - startedRun),
    exitCode: result.code,
  };
  if (result.code !== 0) {
    check.error = bounded(`${result.stderr}\n${result.stdout}`);
  }
  targetChecks.push(check);
  if (result.code !== 0) {
    throw new Error(`${id} failed with exit code ${result.code}: ${check.error}`);
  }
  return result;
}

function run(command, args, optionsForRun = {}) {
  return new Promise((resolveRun, reject) => {
    const bundledNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const npmCli = command === "npm"
      ? process.env.npm_execpath ?? (existsSync(bundledNpmCli) ? bundledNpmCli : undefined)
      : undefined;
    const windowsCommandShim = process.platform === "win32"
      && !npmCli
      && command.toLowerCase().endsWith(".cmd");
    const executable = npmCli ? process.execPath : command;
    const executableArgs = npmCli ? [npmCli, ...args] : args;
    const spawnOptions = {
      cwd: optionsForRun.cwd ?? root,
      env: optionsForRun.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    };
    const child = windowsCommandShim
      ? spawn(quoteWindowsCommand([command, ...args]), {
          ...spawnOptions,
          shell: true,
        })
      : spawn(executable, executableArgs, spawnOptions);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, optionsForRun.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
    if (optionsForRun.input) child.stdin.end(optionsForRun.input);
    else child.stdin.end();
  });
}

function quoteWindowsCommand(parts) {
  return parts.map((part) => {
    const value = String(part);
    if (value.length === 0) return '""';
    if (!/[\s"]/u.test(value)) return value;
    return `"${value.replaceAll('"', '\\"')}"`;
  }).join(" ");
}

function bounded(value, limit = 4_000) {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}\n…truncated`;
}
