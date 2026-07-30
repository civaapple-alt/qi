#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dependencyClosure,
  internalDependencyNames,
  mapConcurrent,
} from "./lib/package-consumer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const keep = process.argv.includes("--keep");
const packageDirectories = [
  "protocol",
  "ai",
  "agent",
  "node",
  "tui",
];
const temporaryRoot = await mkdtemp(join(tmpdir(), "qi-package-consumer-"));
const archiveRoot = join(temporaryRoot, "archives");
const consumerRoot = join(temporaryRoot, "consumer");
const perPackageRoot = join(temporaryRoot, "per-package");
const npmCache = join(temporaryRoot, "npm-cache");
const isolatedNpmUserConfig = join(temporaryRoot, "empty-user.npmrc");
const isolatedNpmGlobalConfig = join(temporaryRoot, "empty-global.npmrc");

try {
  await mkdir(archiveRoot, { recursive: true });
  await mkdir(consumerRoot, { recursive: true });
  await mkdir(perPackageRoot, { recursive: true });
  await writeFile(isolatedNpmUserConfig, "");
  await writeFile(isolatedNpmGlobalConfig, "");
  const dependencies = {};
  const tarballs = [];
  const candidates = [];
  for (const directory of packageDirectories) {
    const packageRoot = join(root, "packages", directory);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const packed = JSON.parse(await runCapture(
      "npm",
      ["pack", "--json", "--pack-destination", archiveRoot],
      packageRoot,
    ));
    const filename = packed[0]?.filename;
    if (!filename) throw new Error(`npm pack did not return a filename for ${manifest.name}`);
    const tarball = join(archiveRoot, filename);
    dependencies[manifest.name] = `file:${tarball.replaceAll("\\", "/")}`;
    tarballs.push({ name: manifest.name, file: filename });
    candidates.push({
      name: manifest.name,
      tarball,
      internalDependencies: internalDependencyNames(manifest),
    });
  }

  await writeFile(join(consumerRoot, "package.json"), `${JSON.stringify({
    name: "qi-isolated-consumer-smoke",
    private: true,
    type: "module",
    dependencies,
    devDependencies: {
      "@types/node": rootManifest.devDependencies["@types/node"],
    },
  }, null, 2)}\n`);
  await writeFile(join(consumerRoot, "smoke.mjs"), createSmokeSource());
  await writeFile(join(consumerRoot, "smoke.ts"), createSmokeSource());
  await writeFile(join(consumerRoot, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["smoke.ts"],
  }, null, 2)}\n`);

  await run("npm", ["install", "--ignore-scripts", "--no-package-lock"], consumerRoot);
  await run("node", ["smoke.mjs"], consumerRoot);
  await run(
    "node",
    [join(root, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"],
    consumerRoot,
  );

  const candidateMap = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const isolatedPackages = await mapConcurrent(candidates, 4, async (candidate) => {
    const closure = dependencyClosure(candidate.name, candidateMap);
    const packageRoot = join(perPackageRoot, candidate.name.replaceAll("/", "__").replaceAll("@", ""));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: `qi-isolated-${candidate.name.slice("@civaapple/qi-".length)}`,
      private: true,
      type: "module",
      dependencies: Object.fromEntries(closure.map((name) => [
        name,
        `file:${candidateMap.get(name).tarball.replaceAll("\\", "/")}`,
      ])),
      devDependencies: {
        "@types/node": rootManifest.devDependencies["@types/node"],
      },
    }, null, 2)}\n`);
    await writeFile(
      join(packageRoot, "smoke.mjs"),
      `const candidate = await import(${JSON.stringify(candidate.name)});\n`
        + `if (Object.keys(candidate).length === 0) throw new Error("empty runtime export surface");\n`,
    );
    await writeFile(
      join(packageRoot, "smoke.ts"),
      `import * as candidate from ${JSON.stringify(candidate.name)};\nvoid candidate;\n`,
    );
    await writeFile(join(packageRoot, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["smoke.ts"],
    }, null, 2)}\n`);
    await runCapture(
      "npm",
      ["install", "--offline", "--ignore-scripts", "--no-package-lock"],
      packageRoot,
    );
    await runCapture("node", ["smoke.mjs"], packageRoot);
    await runCapture(
      "node",
      [join(root, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"],
      packageRoot,
    );
    return {
      name: candidate.name,
      dependencyClosure: closure,
      javascriptImport: "pass",
      typescriptConsumer: "pass",
    };
  });

  process.stdout.write(`${JSON.stringify({
    type: "qi.package-consumer-smoke",
    schemaVersion: 1,
    status: "pass",
    packages: tarballs,
    javascriptImport: "pass",
    typescriptConsumer: "pass",
    perPackageIsolation: "pass",
    isolatedPackages,
    cleaned: !keep,
    ...(keep ? { temporaryRoot } : {}),
  }, null, 2)}\n`);
} finally {
  if (!keep) await rm(temporaryRoot, { recursive: true, force: true });
}

function createSmokeSource() {
  return String.raw`
import assert from "node:assert/strict";
import { QiAgent } from "@civaapple/qi-agent";
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { buildContainerInvocation } from "@civaapple/qi-node/codeact";
import { MultiAgentBaselineGate } from "@civaapple/qi-agent/extensions";
import { compileContext } from "@civaapple/qi-ai/context";
import { failureFingerprint } from "@civaapple/qi-agent/eval";
import { validateGraph } from "@civaapple/qi-agent/extensions";
import { qiSelfModel, queryQiSelfModel } from "@civaapple/qi-agent/extensions";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TurnLoop } from "@civaapple/qi-agent/loop";
import { McpBridge } from "@civaapple/qi-node/mcp";
import { createId } from "@civaapple/qi-protocol";
import { SqliteWatcherScheduler } from "@civaapple/qi-node/scheduler";
import { SqliteEventStore, SqliteMemoryIndex } from "@civaapple/qi-node/storage";
import { parseFrontmatter } from "@civaapple/qi-node/skills";
import { SessionEventHub } from "@civaapple/qi-node/stream";
import { ToolRegistry } from "@civaapple/qi-node/tools";
import * as qiTui from "@civaapple/qi-tui";
import { LocalWorkspace } from "@civaapple/qi-node/workspace";

assert.equal(typeof QiAgent, "function");
assert.equal(typeof InMemoryCapabilityBroker, "function");
assert.equal(typeof compileContext, "function");
assert.equal(typeof InMemoryEventStore, "function");
assert.equal(typeof TurnLoop, "function");
assert.equal(typeof ToolRegistry, "function");
assert.equal(typeof qiTui.TuiPresenter, "function");
assert.equal(typeof qiTui.ListPanel, "function");
assert.equal("TuiRuntime" in qiTui, false);
assert.equal(typeof LocalWorkspace, "function");
assert.equal(typeof SessionEventHub, "function");
assert.match(failureFingerprint({
  assertionId: "assert_consumer",
  evaluatorIdentity: "deterministic:consumer",
  errorCode: "EXAMPLE",
  targetResources: ["consumer"],
}), /^[a-f0-9]{64}$/);
validateGraph({
  id: "consumer",
  version: 1,
  start: "inspect",
  nodes: [{ id: "inspect", observe: [], actions: [], skills: [] }],
  edges: [],
});
assert.equal(new MultiAgentBaselineGate().decision("consumer").enabledByDefault, false);
assert.equal(buildContainerInvocation({}, "/staged").args.includes("--read-only"), true);
assert.equal(parseFrontmatter(
  "---\nname: consumer\ndescription: Consumer smoke\n---\nInspect safely.",
  "Consumer Skill",
).metadata.name, "consumer");
const bridge = new McpBridge("consumer", {
  async listTools() { return []; },
  async callTool() { throw new Error("not bound"); },
});
assert.deepEqual(await bridge.discover(), []);

const sessionStore = new SqliteEventStore(":memory:");
assert.deepEqual(sessionStore.listSessions(), []);
sessionStore.close();
const memoryIndex = new SqliteMemoryIndex(":memory:");
memoryIndex.close();
const scheduler = new SqliteWatcherScheduler(":memory:", {
  async trigger({ runId }) { return runId; },
});
assert.equal(scheduler.get("missing"), undefined);
scheduler.close();
assert.match(createId("ses"), /^ses_/);
assert.equal(qiSelfModel.release, "0.7.2");
assert.ok(Array.isArray(queryQiSelfModel("packages")));

const port = new ScriptedModelPort([[
  { type: "text.delta", delta: "isolated consumer ok" },
  { type: "completed", finishReason: "stop" },
]]);
const agent = new QiAgent({
  modelPort: port,
  model: { provider: "scripted", model: "isolated-consumer" },
});
const result = await agent.prompt("smoke");
assert.equal(result.text, "isolated consumer ok");
`;
}

function run(command, args, cwd) {
  return runCapture(command, args, cwd, true);
}

function runCapture(command, args, cwd, inherit = false) {
  return new Promise((resolveRun, reject) => {
    const bundledNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const npmCli = command === "npm"
      ? process.env.npm_execpath ?? (existsSync(bundledNpmCli) ? bundledNpmCli : undefined)
      : undefined;
    const executable = npmCli ? process.execPath : command;
    const executableArgs = npmCli ? [npmCli, ...args] : args;
    const isolatedNpmEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ![
          "npm_config_allow_scripts",
          "npm_config_userconfig",
          "npm_config_globalconfig",
        ].includes(key.toLowerCase())),
    );
    const child = spawn(executable, executableArgs, {
      cwd,
      windowsHide: true,
      env: command === "npm"
        ? {
            ...isolatedNpmEnvironment,
            NPM_CONFIG_USERCONFIG: isolatedNpmUserConfig,
            NPM_CONFIG_GLOBALCONFIG: isolatedNpmGlobalConfig,
            NPM_CONFIG_CACHE: npmCache,
          }
        : process.env,
      ...(inherit ? { stdio: "inherit" } : {}),
    });
    if (inherit) {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolveRun("");
        else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
