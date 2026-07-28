import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
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
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    const child = windowsCommandShim
      ? spawn(quoteWindowsCommand([command, ...args]), {
          ...spawnOptions,
          shell: true,
        })
      : spawn(executable, executableArgs, spawnOptions);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });
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

async function listTarballEntries(tarballPath) {
  const listed = await run("tar", ["-tzf", tarballPath]);
  assert.equal(listed.code, 0, listed.stderr);
  return listed.stdout.split(/\r?\n/).filter(Boolean);
}

test("CLI package stage bundles runtime packages and packs a runnable bin", async () => {
  // The suite already built the monorepo; restaging without rebuild avoids racing other tests on dist/.
  const staging = join(root, ".cli-package");
  const build = await run(process.execPath, ["scripts/build-cli-package.mjs", "--skip-build"]);
  assert.equal(build.code, 0, `${build.stdout}\n${build.stderr}`);

  const packageJson = JSON.parse(await readFile(join(staging, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@civaapple/qi");
  assert.equal(packageJson.bin.qi, "./dist/main.js");
  assert.equal(packageJson.engines.node, ">=22.19.0");
  assert.ok(packageJson.dependencies["@earendil-works/pi-tui"]);
  assert.equal(packageJson.dependencies["@civaapple/qi-agent"], packageJson.version);
  assert.equal(packageJson.dependencies["@civaapple/qi-node"], packageJson.version);
  assert.ok(packageJson.bundledDependencies.includes("@civaapple/qi-agent"));
  assert.ok(packageJson.bundledDependencies.includes("@civaapple/qi-node"));

  const vendored = JSON.parse(await readFile(join(staging, "node_modules", "@civaapple", "qi-agent", "package.json"), "utf8"));
  assert.equal(vendored.name, "@civaapple/qi-agent");
  await readFile(join(staging, "dist", "main.js"), "utf8");
  await readFile(join(staging, "node_modules", "@civaapple", "qi-node", "dist", "index.js"), "utf8");

  const packed = await run("npm", ["pack", "--json", "--pack-destination", staging], { cwd: staging });
  assert.equal(packed.code, 0, `${packed.stdout}\n${packed.stderr}`);
  const [meta] = JSON.parse(packed.stdout);
  const tarball = join(staging, meta.filename);
  const entries = await listTarballEntries(tarball);
  assert.ok(entries.some((name) => name.endsWith("/dist/main.js")), entries.join("\n"));
  assert.ok(entries.some((name) => name.includes("/node_modules/@civaapple/qi-agent/")), entries.join("\n"));
  assert.ok(!entries.some((name) => name.includes("/src/")));
  assert.ok(!entries.some((name) => name.includes(".qi/")));
  assert.ok(!entries.some((name) => name.includes("/apps/")), "tarball must not contain the monorepo apps/ tree");
  const packedManifest = JSON.parse((await run("tar", ["-xOf", tarball, "package/package.json"])).stdout);
  assert.equal(packedManifest.bin?.qi, "./dist/main.js");
  assert.equal(packedManifest.license, "MIT");
  assert.equal(packedManifest.repository?.url, "git+https://github.com/civaapple-alt/qi.git");
  assert.deepEqual(packedManifest.publishConfig, { access: "public", provenance: true });
  assert.equal(packedManifest.private, undefined);

  const prefix = await mkdtemp(join(tmpdir(), "qi-cli-prefix-"));
  const workspace = await mkdtemp(join(tmpdir(), "qi-cli-ws- "));
  try {
    const install = await run("npm", ["install", "--global", "--prefix", prefix, tarball], {
      env: {
        ...process.env,
        npm_config_cache: join(prefix, "npm-cache"),
      },
    });
    assert.equal(install.code, 0, `${install.stdout}\n${install.stderr}`);

    const qiCommand = process.platform === "win32"
      ? join(prefix, "qi.cmd")
      : join(prefix, "bin", "qi");
    const help = await run(qiCommand, ["--help"], { cwd: workspace });
    assert.equal(help.code, 0, `${help.stdout}\n${help.stderr}`);
    assert.match(help.stdout, /qi \[WORKSPACE\]/);
    assert.match(help.stdout, /--add-dir PATH/);

    const version = await run(qiCommand, ["--version"], { cwd: workspace });
    assert.equal(version.code, 0, `${version.stdout}\n${version.stderr}`);
    assert.match(version.stdout, /^qi \d+\.\d+\.\d+/);
  } finally {
    await rm(prefix, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
