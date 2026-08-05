import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  convertClaudeMcpJson,
  inspectClaudePlugin,
} from "./claude-adapter.js";
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
    if (entry.source.kind !== "vendored") {
      throw new Error(`Remote plugin sources are not installed yet (P4): ${entry.source.kind}`);
    }
    const sourceRoot = resolve(marketplace.installLocation, entry.source.path);
    const inspected = await inspectClaudePlugin(sourceRoot, entry.name);
    if (inspected.support === "unsupported") {
      throw new Error(
        `Plugin ${entry.name} has no supported Qi components (${inspected.unsupportedReasons.join(", ") || "empty"})`,
      );
    }
    const pin = await digestTreeMarker(sourceRoot, entry);
    const cachePath = resolve(this.#cacheRoot, marketplaceName, entry.name, pin);
    await mkdir(dirname(cachePath), { recursive: true });
    await rm(cachePath, { recursive: true, force: true });
    await cp(sourceRoot, cachePath, { recursive: true });
    await writeFile(
      resolve(cachePath, ".qi-plugin-install.json"),
      `${JSON.stringify({
        marketplace: marketplaceName,
        name: entry.name,
        pin,
        support: inspected.support,
        unsupportedReasons: inspected.unsupportedReasons,
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    const record: InstalledPluginRecord = Object.freeze({
      key: `${entry.name}@${marketplaceName}`,
      marketplace: marketplaceName,
      name: entry.name,
      pin,
      cachePath,
      installedAt: new Date().toISOString(),
      sourceKind: entry.source.kind,
    });
    const installed = await this.#readInstalled();
    installed.plugins[record.key] = record;
    await this.#writeInstalled(installed);
    return record;
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

  async #readInstalled(): Promise<{ schemaVersion: 1; plugins: Record<string, InstalledPluginRecord> }> {
    try {
      const raw = JSON.parse(await readFile(this.#installedFile, "utf8")) as unknown;
      if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.plugins)) {
        throw new TypeError("installed.json schemaVersion must be 1");
      }
      return { schemaVersion: 1, plugins: raw.plugins as Record<string, InstalledPluginRecord> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, plugins: {} };
      }
      throw error;
    }
  }

  async #writeInstalled(value: { schemaVersion: 1; plugins: Record<string, InstalledPluginRecord> }): Promise<void> {
    await mkdir(resolve(this.#qiHome, "plugins"), { recursive: true });
    await writeFile(this.#installedFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
