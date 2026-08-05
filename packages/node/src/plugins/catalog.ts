import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inspectClaudePlugin,
  listPluginAgents,
  listPluginCommands,
  loadPluginPrompt,
} from "./claude-adapter.js";
import type { PluginInstaller } from "./installer.js";
import type { MarketplaceRegistry } from "./registry.js";
import { searchMarketplacePlugins } from "./marketplace.js";
import type {
  InspectedPlugin,
  InstalledPluginRecord,
  MarketplacePluginEntry,
  PluginAgentRef,
  PluginCommandRef,
} from "./types.js";

export interface EnabledPluginState {
  readonly key: string;
  readonly enabled: boolean;
}

export class PluginCatalog {
  readonly #qiHome: string;
  readonly #enabledFile: string;
  readonly #registry: MarketplaceRegistry;
  readonly #installer: PluginInstaller;

  constructor(qiHome: string, registry: MarketplaceRegistry, installer: PluginInstaller) {
    this.#qiHome = resolve(qiHome);
    this.#enabledFile = resolve(this.#qiHome, "plugins", "enabled.json");
    this.#registry = registry;
    this.#installer = installer;
  }

  async enable(key: string): Promise<EnabledPluginState> {
    await this.#installer.getInstalled(key);
    const enabled = await this.#readEnabled();
    enabled.plugins[key] = true;
    await this.#writeEnabled(enabled);
    return { key, enabled: true };
  }

  async disable(key: string): Promise<EnabledPluginState> {
    const enabled = await this.#readEnabled();
    enabled.plugins[key] = false;
    await this.#writeEnabled(enabled);
    return { key, enabled: false };
  }

  async listEnabled(): Promise<readonly string[]> {
    const enabled = await this.#readEnabled();
    return Object.entries(enabled.plugins)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .sort();
  }

  async searchMarketplace(marketplaceName: string, query: string): Promise<readonly MarketplacePluginEntry[]> {
    const catalog = await this.#registry.loadCatalog(marketplaceName);
    return searchMarketplacePlugins(catalog, query);
  }

  async inspectInstalled(key: string): Promise<InspectedPlugin & { readonly record: InstalledPluginRecord }> {
    const record = await this.#installer.getInstalled(key);
    const inspected = await inspectClaudePlugin(record.cachePath, record.name);
    return Object.freeze({ ...inspected, record });
  }

  async listCommands(query = ""): Promise<readonly PluginCommandRef[]> {
    const refs: PluginCommandRef[] = [];
    for (const key of await this.listEnabled()) {
      const record = await this.#installer.getInstalled(key);
      refs.push(...await listPluginCommands(record.cachePath, record.name, record.marketplace));
    }
    return filterByQuery(refs, query);
  }

  async listAgents(query = ""): Promise<readonly PluginAgentRef[]> {
    const refs: PluginAgentRef[] = [];
    for (const key of await this.listEnabled()) {
      const record = await this.#installer.getInstalled(key);
      refs.push(...await listPluginAgents(record.cachePath, record.name, record.marketplace));
    }
    return filterByQuery(refs, query);
  }

  async resolveCommand(id: string): Promise<PluginCommandRef> {
    const commands = await this.listCommands();
    const found = commands.find((entry) => entry.id === id || entry.name === id || entry.plugin === id);
    if (!found) throw new Error(`Unknown plugin command: ${id}`);
    return found;
  }

  async resolveAgent(id: string): Promise<PluginAgentRef> {
    const agents = await this.listAgents();
    const found = agents.find((entry) => entry.id === id || entry.name === id);
    if (!found) throw new Error(`Unknown plugin agent: ${id}`);
    return found;
  }

  async loadCommandBody(id: string): Promise<{ readonly ref: PluginCommandRef; readonly body: string; readonly digest: string }> {
    const ref = await this.resolveCommand(id);
    const loaded = await loadPluginPrompt(ref.path);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(loaded.body).digest("hex");
    return { ref, body: loaded.body, digest };
  }

  async loadAgentBody(id: string): Promise<{ readonly ref: PluginAgentRef; readonly body: string; readonly digest: string }> {
    const ref = await this.resolveAgent(id);
    const loaded = await loadPluginPrompt(ref.path);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(loaded.body).digest("hex");
    return { ref, body: loaded.body, digest };
  }

  async #readEnabled(): Promise<{ schemaVersion: 1; plugins: Record<string, boolean> }> {
    try {
      const raw = JSON.parse(await readFile(this.#enabledFile, "utf8")) as unknown;
      if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.plugins)) {
        throw new TypeError("enabled.json schemaVersion must be 1");
      }
      const plugins: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(raw.plugins)) {
        plugins[key] = Boolean(value);
      }
      return { schemaVersion: 1, plugins };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, plugins: {} };
      }
      throw error;
    }
  }

  async #writeEnabled(value: { schemaVersion: 1; plugins: Record<string, boolean> }): Promise<void> {
    await mkdir(resolve(this.#qiHome, "plugins"), { recursive: true });
    await writeFile(this.#enabledFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

function filterByQuery<T extends { readonly id: string; readonly name: string; readonly description: string; readonly plugin: string }>(
  refs: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  const filtered = !needle
    ? refs
    : refs.filter((entry) => `${entry.id}\n${entry.name}\n${entry.plugin}\n${entry.description}`.toLowerCase().includes(needle));
  return Object.freeze([...filtered].sort((left, right) => left.id.localeCompare(right.id)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
