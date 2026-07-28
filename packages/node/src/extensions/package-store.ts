import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { x as extractTar } from "tar";
import {
  parseQiPluginManifest,
  type LockedPackageSource,
  type QiPluginManifest,
} from "@civaapple/qi-agent/extensions";
import { validateDeclarativeTree } from "./declarations.js";

export interface InstalledDeclarativePackage {
  readonly manifest: QiPluginManifest;
  readonly source: LockedPackageSource;
  readonly storePath: string;
}

export type ResourceLayer =
  | "project-direct"
  | "project-packages"
  | "user-direct"
  | "user-packages"
  | "builtins";

export interface LayeredResource {
  readonly layer: ResourceLayer;
  readonly kind: string;
  readonly id: string;
  readonly source: string;
}

export class DeclarativePackageStore {
  readonly #root: string;
  readonly #storeRoot: string;
  readonly #stagingRoot: string;

  constructor(qiHome: string) {
    this.#root = resolve(qiHome, "packages");
    this.#storeRoot = resolve(this.#root, "store");
    this.#stagingRoot = resolve(this.#root, "staging");
  }

  async installLocal(
    sourceDirectory: string,
    options: { readonly record?: boolean } = {},
  ): Promise<InstalledDeclarativePackage> {
    const source = resolve(sourceDirectory);
    return this.#installDirectory(source, {
      type: "local",
      specifier: sourceDirectory,
      resolved: source,
    }, options.record ?? true);
  }

  async installNpm(
    specifier: string,
    options: { readonly registry?: string; readonly record?: boolean } = {},
  ): Promise<InstalledDeclarativePackage> {
    const { name, version } = parseExactNpmSpecifier(specifier);
    const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
    const metadataUrl = `${registry}/${name.replace("/", "%2f")}/${version}`;
    const metadataResponse = await fetch(metadataUrl, { redirect: "error" });
    if (!metadataResponse.ok) throw new Error(`npm metadata request failed: ${metadataResponse.status}`);
    const metadata = await metadataResponse.json() as {
      version?: unknown;
      dist?: { tarball?: unknown; integrity?: unknown };
    };
    if (metadata.version !== version || typeof metadata.dist?.tarball !== "string" ||
        typeof metadata.dist.integrity !== "string") {
      throw new Error("npm registry metadata did not contain the exact version, tarball, and integrity");
    }
    assertPinnedPackageSource({
      type: "npm",
      resolved: `${name}@${version}`,
      integrity: metadata.dist.integrity,
    });
    const response = await fetch(metadata.dist.tarball, { redirect: "follow" });
    if (!response.ok) throw new Error(`npm tarball request failed: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    verifyIntegrity(archive, metadata.dist.integrity);
    const fetchStaging = resolve(this.#stagingRoot, `npm-${randomUUID()}`);
    const archivePath = resolve(fetchStaging, "package.tgz");
    const unpacked = resolve(fetchStaging, "unpacked");
    await mkdir(unpacked, { recursive: true });
    try {
      await writeFile(archivePath, archive, { flag: "wx" });
      await extractTar({
        file: archivePath,
        cwd: unpacked,
        strip: 1,
        strict: true,
        preservePaths: false,
      });
      return await this.#installDirectory(unpacked, {
        type: "npm",
        specifier,
        resolved: `${name}@${version}`,
        integrity: metadata.dist.integrity,
      }, options.record ?? true);
    } finally {
      await rm(fetchStaging, { recursive: true, force: true });
    }
  }

  async installGit(
    specifier: string,
    options: { readonly record?: boolean } = {},
  ): Promise<InstalledDeclarativePackage> {
    const match = /^(.*)#([0-9a-f]{40})$/i.exec(specifier);
    if (!match) throw new Error("Git package sources must end with an exact #<40-character-commit>");
    const [, repository, commit] = match;
    const fetchStaging = resolve(this.#stagingRoot, `git-${randomUUID()}`);
    const checkout = resolve(fetchStaging, "checkout");
    await mkdir(fetchStaging, { recursive: true });
    try {
      await run("git", [
        "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "clone", "--no-checkout", "--filter=blob:none", "--", repository!, checkout,
      ]);
      await run("git", [
        "-C", checkout,
        "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "checkout", "--detach", commit!,
      ]);
      const actual = (await run("git", ["-C", checkout, "rev-parse", "HEAD"])).trim();
      if (actual.toLowerCase() !== commit!.toLowerCase()) throw new Error("Git checkout did not resolve to the pinned commit");
      await rm(resolve(checkout, ".git"), { recursive: true, force: true });
      return await this.#installDirectory(checkout, {
        type: "git",
        specifier,
        resolved: `${repository}#${commit}`,
      }, options.record ?? true);
    } finally {
      await rm(fetchStaging, { recursive: true, force: true });
    }
  }

  async #installDirectory(
    source: string,
    lockedSource: Omit<LockedPackageSource, "digest">,
    record: boolean,
  ): Promise<InstalledDeclarativePackage> {
    const validation = await validateDeclarativeTree(source);
    const manifestPath = resolve(source, "qi-plugin.json");
    const manifest = parseQiPluginManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    await assertManifestResourcesExist(source, manifest);
    await rejectPackageScripts(source);
    const digest = await hashTree(source, validation.files);
    const digestKey = `sha256-${digest}` as const;
    const destination = resolve(this.#storeRoot, digestKey);
    await mkdir(this.#stagingRoot, { recursive: true });
    await mkdir(this.#storeRoot, { recursive: true });
    const staging = resolve(this.#stagingRoot, `${digestKey}-${randomUUID()}`);
    try {
      await cp(source, staging, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        filter: (candidate) => basename(candidate) !== "node_modules",
      });
      await validateDeclarativeTree(staging);
      try {
        await rename(staging, destination);
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY", "EPERM"]).has((error as NodeJS.ErrnoException).code ?? "")) {
          throw error;
        }
        await rm(staging, { recursive: true, force: true });
      }
      await makeTreeReadOnly(destination);
      const sourceRecord: LockedPackageSource = { ...lockedSource, digest: digestKey };
      if (record) await writeInstalledRecord(this.#root, manifest, sourceRecord);
      return {
        manifest,
        source: sourceRecord,
        storePath: destination,
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

export function resolveLayeredResources(
  resources: readonly LayeredResource[],
): readonly LayeredResource[] {
  const order: readonly ResourceLayer[] = [
    "project-direct",
    "project-packages",
    "user-direct",
    "user-packages",
    "builtins",
  ];
  const selected = new Map<string, LayeredResource>();
  for (const layer of order) {
    const layerKeys = new Set<string>();
    for (const resource of resources.filter((candidate) => candidate.layer === layer)) {
      const key = `${resource.kind}:${resource.id}`;
      if (layerKeys.has(key)) throw new Error(`Conflicting resource ${key} in layer ${layer}`);
      layerKeys.add(key);
      if (!selected.has(key)) selected.set(key, resource);
    }
  }
  return [...selected.values()];
}

export function assertPinnedPackageSource(source: {
  readonly type: "npm" | "git" | "local";
  readonly resolved?: string;
  readonly integrity?: string;
}): void {
  if (source.type === "npm") {
    let exact = true;
    try {
      if (!source.resolved) exact = false;
      else parseExactNpmSpecifier(source.resolved);
    } catch {
      exact = false;
    }
    if (!exact || !source.integrity?.startsWith("sha512-")) {
      throw new Error("npm plugins require an exact version and registry sha512 integrity");
    }
  } else if (source.type === "git") {
    if (!source.resolved || !/(?:#|@)[0-9a-f]{40}$/i.test(source.resolved)) {
      throw new Error("Git plugins require an exact 40-character commit");
    }
  } else if (!source.resolved) {
    throw new Error("Local plugins require a resolved source path and content digest");
  }
}

async function hashTree(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(resolve(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertManifestResourcesExist(root: string, manifest: QiPluginManifest): Promise<void> {
  for (const contribution of manifest.resources) {
    const info = await stat(resolve(root, contribution.path));
    if (!info.isFile()) throw new Error(`Plugin resource is not a file: ${contribution.path}`);
  }
}

async function rejectPackageScripts(root: string): Promise<void> {
  try {
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts?: unknown;
    };
    if (packageJson.scripts && typeof packageJson.scripts === "object" &&
        Object.keys(packageJson.scripts).length > 0) {
      throw new Error("Declarative packages must not contain npm lifecycle or package scripts");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(path);
      await chmod(path, 0o555).catch(() => undefined);
    } else {
      await chmod(path, 0o444).catch(() => undefined);
    }
  }
  await chmod(root, 0o555).catch(() => undefined);
}

function parseExactNpmSpecifier(specifier: string): { name: string; version: string } {
  const separator = specifier.lastIndexOf("@");
  if (separator <= 0) throw new Error("npm package sources require name@exact-version");
  const name = specifier.slice(0, separator);
  const version = specifier.slice(separator + 1);
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("npm package sources require a valid package name and exact semver version");
  }
  return { name, version };
}

function verifyIntegrity(content: Uint8Array, integrity: string): void {
  const match = /^(sha512)-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match) throw new Error("npm package integrity must be sha512");
  const actual = createHash("sha512").update(content).digest("base64");
  if (actual !== match[2]) throw new Error("npm tarball integrity mismatch");
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited ${String(code)}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

async function writeInstalledRecord(
  packagesRoot: string,
  manifest: QiPluginManifest,
  source: LockedPackageSource,
): Promise<void> {
  const lockPath = resolve(packagesRoot, "lock.json");
  let current: { schemaVersion: 1; packages: Record<string, unknown> } = {
    schemaVersion: 1,
    packages: {},
  };
  try {
    current = JSON.parse(await readFile(lockPath, "utf8")) as typeof current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  current.packages[manifest.id] = { version: manifest.version, source };
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(current, null, 2)}\n`);
}
