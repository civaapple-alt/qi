import { createHash } from "node:crypto";
import { mkdir, mkdtemp, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  convertClaudeMcpJson,
  inspectClaudePlugin,
} from "./claude-adapter.js";
import { acquireImmutableSkillSource } from "../skills/source.js";
import type { MarketplaceRegistry } from "./registry.js";
import type { InstalledPluginRecord, MarketplacePluginEntry } from "./types.js";

export class PluginInstaller {
  readonly #qiHome: string;
  readonly #cacheRoot: string;
  readonly #installedFile: string;
  readonly #registry: MarketplaceRegistry;

  constructor(qiHome: string, registry: MarketplaceRegistry) {
    this.#qiHome = resolve(qiHome);
    this.#cacheRoot = resolve(this.#qiHome, "plugins", "cache");
    this.#installedFile = resolve(this.#qiHome, "plugins", "installed.json");
    this.#registry = registry;
  }

  async install(marketplaceName: string, pluginName: string): Promise<InstalledPluginRecord> {
    const catalog = await this.#registry.loadCatalog(marketplaceName);
    const marketplace = await this.#registry.get(marketplaceName);
    const resolvedName = catalog.renames[pluginName] ?? pluginName;
    const entry = catalog.plugins.find((plugin) => plugin.name === resolvedName);
    if (!entry) throw new Error(`Plugin not found in marketplace ${marketplaceName}: ${pluginName}`);
    let sourceRoot: string;
    let cleanup: (() => Promise<void>) | undefined;
    let sourceUrl: string | undefined;
    let commit: string | undefined;
    let treeDigest: string | undefined;
    if (entry.source.kind === "vendored") {
      sourceRoot = resolve(marketplace.installLocation, entry.source.path);
      commit = marketplace.resolvedRevision;
      sourceUrl = marketplace.source.kind === "github"
        ? `https://github.com/${marketplace.source.repo}.git`
        : undefined;
    } else if (entry.source.kind === "url") {
      const url = canonicalGitUrl(entry.source.url);
      const sha = entry.source.sha;
      if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new TypeError("Remote plugin URL sources require an exact 40-character sha");
      const acquired = await acquireImmutableSkillSource({ type: "git", repository: url, commit: sha, subdir: "." });
      sourceRoot = acquired.root;
      cleanup = acquired.cleanup;
      sourceUrl = url;
      commit = sha.toLowerCase();
    } else {
      throw new Error(`Remote plugin source is not supported yet: ${entry.source.kind}`);
    }
    if (sourceUrl === undefined) sourceUrl = await readPluginRepository(sourceRoot);
    try {
      const inspected = await inspectClaudePlugin(sourceRoot, entry.name);
      if (inspected.support === "unsupported") {
        throw new Error(
          `Plugin ${entry.name} has no supported Qi components (${inspected.unsupportedReasons.join(", ") || "empty"})`,
        );
      }
      const pin = commit ?? await digestTreeMarker(sourceRoot, entry);
      const cachePath = resolve(this.#cacheRoot, marketplaceName, entry.name, pin);
      const marker = resolve(cachePath, ".qi-plugin-install.json");
      const installedAt = new Date().toISOString();
      await mkdir(dirname(cachePath), { recursive: true });
      try {
        const markerRaw = JSON.parse(await readFile(marker, "utf8")) as unknown;
        if (isRecord(markerRaw) && typeof markerRaw.treeDigest === "string") treeDigest = markerRaw.treeDigest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const staging = await mkdtemp(resolve(dirname(cachePath), ".staging-"));
        try {
          await copyPluginTree(sourceRoot, staging);
          treeDigest = await digestTree(staging);
          await writeFile(resolve(staging, ".qi-plugin-install.json"), `${JSON.stringify({
            marketplace: marketplaceName,
            name: entry.name,
            pin,
            treeDigest,
            commit,
            sourceUrl,
            declaredMarketplace: marketplace.declaredName,
            version: await readPluginVersion(staging),
            support: inspected.support,
            unsupportedReasons: inspected.unsupportedReasons,
            installedAt,
          }, null, 2)}\n`, "utf8");
          try { await rename(staging, cachePath); } catch (renameError) {
            try { await readFile(marker, "utf8"); } catch { throw renameError; }
          }
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
      const version = await readPluginVersion(cachePath);
      treeDigest ??= await digestTree(cachePath);
      const record: InstalledPluginRecord = Object.freeze({
        key: `${entry.name}@${marketplaceName}`,
        marketplace: marketplaceName,
        name: entry.name,
        pin,
        cachePath,
        installedAt,
        sourceKind: entry.source.kind,
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
        ...(marketplace.resolvedRevision === undefined ? {} : { marketplaceRevision: marketplace.resolvedRevision }),
        ...(commit === undefined ? {} : { commit }),
        ...(version === undefined ? {} : { version }),
        ...(treeDigest === undefined ? {} : { treeDigest }),
        ...(marketplace.declaredName === undefined ? {} : { declaredMarketplace: marketplace.declaredName }),
      });
      const installed = await this.#readInstalled();
      installed.plugins[record.key] = record;
      await this.#writeInstalled(installed);
      return record;
    } finally {
      await cleanup?.();
    }
  }

  async listInstalled(): Promise<readonly InstalledPluginRecord[]> {
    const installed = await this.#readInstalled();
    return Object.values(installed.plugins).sort((left, right) => left.key.localeCompare(right.key));
  }

  async getInstalled(key: string): Promise<InstalledPluginRecord> {
    const installed = await this.#readInstalled();
    const found = installed.plugins[key];
    if (!found) throw new Error(`Plugin not installed: ${key}`);
    return found;
  }

  /**
   * Write converted MCP declarations under `$QI_HOME/resources/mcp/<marketplace>/`
   * (inert; still need bind). Removes a legacy flat `$QI_HOME/resources/mcp/<name>.json`
   * when present so discovery does not see two files for the same server name.
   */
  async materializeMcpDeclarations(key: string): Promise<readonly string[]> {
    const record = await this.getInstalled(key);
    const rawPath = resolve(record.cachePath, ".mcp.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(rawPath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const converted = await convertClaudeMcpJson(raw, record.name);
    const outRoot = resolve(this.#qiHome, "resources", "mcp", record.marketplace);
    await mkdir(outRoot, { recursive: true });
    const written: string[] = [];
    for (const declaration of converted) {
      const body: Record<string, unknown> = {
        name: declaration.name,
        transport: declaration.transport,
        enabled: true,
      };
      if (declaration.command) body.command = declaration.command;
      if (declaration.args?.length) body.args = declaration.args;
      if (declaration.url) body.url = declaration.url;
      if (declaration.env && Object.keys(declaration.env).length > 0) body.env = declaration.env;
      if (declaration.headers && Object.keys(declaration.headers).length > 0) body.headers = declaration.headers;
      // npx/uvx often need longer than the 15s default on first package resolve.
      if (
        declaration.transport === "stdio"
        && (declaration.command === "npx" || declaration.command === "uvx")
      ) {
        body.connect_timeout_ms = 60_000;
      }
      const path = resolve(outRoot, `${declaration.name}.json`);
      await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      const legacyFlat = resolve(this.#qiHome, "resources", "mcp", `${declaration.name}.json`);
      if (legacyFlat !== path) {
        await rm(legacyFlat, { force: true });
      }
      written.push(path);
    }
    return written;
  }

  async #readInstalled(): Promise<{ schemaVersion: 2; plugins: Record<string, InstalledPluginRecord> }> {
    try {
      const raw = JSON.parse(await readFile(this.#installedFile, "utf8")) as unknown;
      if (!isRecord(raw) || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || !isRecord(raw.plugins)) {
        throw new TypeError("installed.json schemaVersion must be 1 or 2");
      }
      return { schemaVersion: 2, plugins: raw.plugins as Record<string, InstalledPluginRecord> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 2, plugins: {} };
      }
      throw error;
    }
  }

  async #writeInstalled(value: { schemaVersion: 2; plugins: Record<string, InstalledPluginRecord> }): Promise<void> {
    await mkdir(resolve(this.#qiHome, "plugins"), { recursive: true });
    const staging = `${this.#installedFile}.tmp-${process.pid}`;
    await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(staging, this.#installedFile);
  }
}

function canonicalGitUrl(value: string | undefined): string {
  if (!value) throw new TypeError("Remote plugin URL is required");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash || url.port) {
    throw new TypeError("Plugin URL must be credential-free https://github.com/<owner>/<repo>.git");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TypeError("Plugin URL must identify a GitHub owner/repository");
  return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/i, "")}.git`;
}

async function readPluginVersion(root: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(resolve(root, ".claude-plugin", "plugin.json"), "utf8")) as unknown;
    return isRecord(raw) && typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function readPluginRepository(root: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(resolve(root, ".claude-plugin", "plugin.json"), "utf8")) as unknown;
    return isRecord(raw) && typeof raw.repository === "string" && raw.repository.trim() ? raw.repository.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function digestTreeMarker(sourceRoot: string, entry: MarketplacePluginEntry): Promise<string> {
  const hash = createHash("sha256");
  hash.update(entry.name);
  hash.update("\0");
  hash.update(JSON.stringify(entry.source));
  hash.update("\0");
  hash.update(sourceRoot);
  // Stable short pin for cache path; content integrity is the copied tree itself.
  return hash.digest("hex").slice(0, 16);
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== ".git" && entry.name !== ".qi-plugin-install.json")
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const rel = relative(root, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        hash.update(rel);
        hash.update("\0");
        hash.update(await readFile(absolute));
        hash.update("\0");
      } else {
        throw new Error(`Plugin cache contains unsupported filesystem entry: ${rel}`);
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function copyPluginTree(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Plugin source root must be a regular directory");
  }
  async function copyDirectory(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const fromPath = resolve(from, entry.name);
      const toPath = resolve(to, entry.name);
      const stat = await lstat(fromPath);
      if (stat.isSymbolicLink() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
        throw new Error(`Plugin source contains an unsupported filesystem entry: ${entry.name}`);
      }
      if (stat.isDirectory()) {
        await copyDirectory(fromPath, toPath);
      } else if (stat.isFile()) {
        await writeFile(toPath, await readFile(fromPath));
      } else {
        throw new Error(`Plugin source contains an unsupported filesystem entry: ${entry.name}`);
      }
    }
  }
  await copyDirectory(source, destination);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
