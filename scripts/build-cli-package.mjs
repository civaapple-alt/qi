#!/usr/bin/env node
/**
 * Stage the self-contained `@civaapple/qi` preview package under `.cli-package/`.
 * Until the public package release gate passes, internal `@civaapple/qi-*` packages are
 * vendored into the CLI preview via bundledDependencies.
 */
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = join(root, ".cli-package");
const cliManifest = JSON.parse(await readFile(join(root, "apps", "cli", "package.json"), "utf8"));
const version = cliManifest.version;

const bundledPackages = [
  "protocol",
  "kernel",
  "session-store",
  "llm",
  "context",
  "capability",
  "codeact",
  "tools",
  "workspace",
  "loop",
  "skills",
  "eval",
  "coordinator",
  "introspection",
  "tui",
];

const publicDependencies = {
  "@earendil-works/pi-tui": "0.81.1",
  "@sinclair/typebox": "0.34.52",
  diff: "9.0.0",
  openai: "^6.48.0",
  "smol-toml": "1.7.0",
  yaml: "2.9.0",
};

const bundledRuntimeDependencies = Object.fromEntries(
  bundledPackages.map((name) => [`@civaapple/qi-${name}`, version]),
);

const skipBuild = process.argv.includes("--skip-build");
if (!skipBuild) {
  await run("npm", ["run", "build"], root);
}
await removeStagingRoot(stagingRoot);
await mkdir(join(stagingRoot, "dist"), { recursive: true });
await mkdir(join(stagingRoot, "node_modules", "@civaapple"), { recursive: true });

await cp(join(root, "apps", "cli", "dist"), join(stagingRoot, "dist"), { recursive: true });
for (const name of bundledPackages) {
  const source = join(root, "packages", name);
  const target = join(stagingRoot, "node_modules", "@civaapple", `qi-${name}`);
  await mkdir(target, { recursive: true });
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
  const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await writeFile(
    join(target, "package.json"),
    `${JSON.stringify({
      name: packageJson.name,
      version: packageJson.version,
      type: "module",
      main: packageJson.main,
      types: packageJson.types,
      exports: packageJson.exports,
    }, null, 2)}\n`,
  );
}

const readme = await readFile(join(root, "README.md"), "utf8");
await writeFile(join(stagingRoot, "README.md"), readme);
try {
  await cp(join(root, "LICENSE"), join(stagingRoot, "LICENSE"));
} catch {
  // LICENSE is required before a public registry publish; pack smoke may still proceed.
}

await writeFile(
  join(stagingRoot, "package.json"),
  `${JSON.stringify({
    name: cliManifest.name,
    version,
    description: "Evidence-first local Agent runtime and terminal control surface",
    type: "module",
    license: cliManifest.license,
    repository: cliManifest.repository,
    homepage: cliManifest.homepage,
    bugs: cliManifest.bugs,
    publishConfig: { access: "public", provenance: true },
    engines: { node: ">=22.19.0" },
    bin: { qi: "./dist/main.js" },
    files: ["dist", "README.md", "LICENSE"],
    dependencies: {
      ...publicDependencies,
      ...bundledRuntimeDependencies,
    },
    // Present in staging node_modules and listed here so npm pack embeds them instead of
    // resolving @civaapple/qi-* packages from the public registry during preview installs.
    bundledDependencies: Object.keys(bundledRuntimeDependencies),
  }, null, 2)}\n`,
);

process.stdout.write(`Staged CLI package at ${stagingRoot}\n`);

if (process.argv.includes("--pack")) {
  // Pack from the staging directory itself. Using --prefix from the monorepo root
  // can accidentally pack the workspace root instead of the CLI artifact.
  await run("npm", ["pack", "--pack-destination", stagingRoot], stagingRoot);
  process.stdout.write(`Packed CLI tarball into ${stagingRoot}\n`);
}

/**
 * Windows often holds a handle on `.cli-package` (Explorer, AV, a previous npm pack cwd).
 * Retry, and if needed rename the tree out of the way so staging can proceed.
 */
async function removeStagingRoot(path) {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      if (process.platform === "win32") {
        const trash = `${path}.trash-${process.pid}-${randomBytes(4).toString("hex")}`;
        try {
          await rename(path, trash);
          void rm(trash, { recursive: true, force: true }).catch(() => undefined);
          return;
        } catch {
          // Directory still locked; fall through to backoff retry.
        }
      }
      if (attempt === maxAttempts) {
        throw new Error(
          `Could not remove ${path} (${code}). Close anything using that folder ` +
            `(Explorer, a running qi from the staged install, antivirus scan) and retry.`,
          { cause: error },
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40 * attempt * attempt));
    }
  }
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const windows = process.platform === "win32";
    const executable = windows && command === "npm" ? "npm.cmd" : command;
    // Avoid DEP0190: do not pass argv alongside shell:true. Quote a single command line instead.
    const useShell = windows && String(executable).toLowerCase().endsWith(".cmd");
    const child = useShell
      ? spawn(quoteCommandLine([executable, ...args]), {
          cwd,
          stdio: "inherit",
          shell: true,
          windowsHide: true,
        })
      : spawn(executable, args, {
          cwd,
          stdio: "inherit",
          windowsHide: true,
        });
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
    child.once("error", reject);
  });
}

function quoteCommandLine(parts) {
  return parts.map((part) => {
    if (part.length === 0) return '""';
    if (!/[\s"]/u.test(part)) return part;
    return `"${part.replaceAll('"', '\\"')}"`;
  }).join(" ");
}
