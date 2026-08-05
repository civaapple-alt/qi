import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  inspectClaudePlugin,
  listPluginAgents,
  listPluginCommands,
  listPluginSkills,
  loadPluginPrompt,
} from "./claude-adapter.js";
import { SkillLoader } from "../skills/skill-loader.js";
import type { PluginInstaller } from "./installer.js";
import type { MarketplaceRegistry } from "./registry.js";
import { searchMarketplacePlugins } from "./marketplace.js";
import type {
  InspectedPlugin,
  InstalledPluginRecord,
  MarketplacePluginEntry,
  PluginAgentRef,
  PluginCommandRef,
  PluginSkillRef,
  PluginSkillSnapshot,
  PluginSkillStatus,
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
  #runSkillSnapshot: PluginSkillSnapshot | undefined;

  constructor(qiHome: string, registry: MarketplaceRegistry, installer: PluginInstaller) {
    this.#qiHome = resolve(qiHome);
    this.#enabledFile = resolve(this.#qiHome, "plugins", "enabled.json");
    this.#registry = registry;
    this.#installer = installer;
  }

  /** Freeze the plugin Skill view used by the active Run. */
  setRunSkillSnapshot(snapshot: PluginSkillSnapshot | undefined): void {
    this.#runSkillSnapshot = snapshot;
  }

  async enable(key: string): Promise<EnabledPluginState> {
    const record = await this.#installer.getInstalled(key);
    const enabled = await this.#readEnabled();
    const conflicting = Object.entries(enabled.plugins)
      .filter(([other, value]) => value && other !== key)
      .map(([other]) => other);
    for (const other of conflicting) {
      const installed = await this.#installer.getInstalled(other);
      if (installed.name === record.name) {
        throw new Error(`Plugin ${record.name} is already enabled as ${other}; disable it before enabling ${key}`);
      }
    }
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

  async getInstalled(key: string): Promise<InstalledPluginRecord> {
    return this.#installer.getInstalled(key);
  }

  async listInstalled(query = ""): Promise<readonly InstalledPluginRecord[]> {
    const needle = query.trim().toLowerCase();
    const records = await this.#installer.listInstalled();
    return Object.freeze(records.filter((record) => !needle
      || `${record.key}\n${record.name}\n${record.marketplace}\n${record.version ?? ""}`.toLowerCase().includes(needle)));
  }

  async listSkills(query = ""): Promise<readonly PluginSkillRef[]> {
    if (this.#runSkillSnapshot) return filterByQuery(this.#runSkillSnapshot.skills, query);
    const refs: PluginSkillRef[] = [];
    for (const key of await this.listEnabled()) {
      const record = await this.#installer.getInstalled(key);
      refs.push(...await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key));
    }
    return filterByQuery(refs, query);
  }

  async listInstalledSkills(query = ""): Promise<readonly PluginSkillStatus[]> {
    const enabled = new Set(await this.listEnabled());
    const statuses: PluginSkillStatus[] = [];
    for (const record of await this.#installer.listInstalled()) {
      const refs = await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key);
      for (const ref of refs) statuses.push(Object.freeze({ ref, enabled: enabled.has(record.key) }));
    }
    const needle = query.trim().toLowerCase();
    return Object.freeze(statuses
      .filter(({ ref }) => !needle
        || `${ref.id}\n${ref.name}\n${ref.marketplace}\n${ref.description}`.toLowerCase().includes(needle))
      .sort((left, right) => left.ref.id.localeCompare(right.ref.id)));
  }

  async snapshotEnabledSkills(): Promise<PluginSkillSnapshot> {
    const plugins: InstalledPluginRecord[] = [];
    const skills: PluginSkillRef[] = [];
    for (const key of await this.listEnabled()) {
      const record = await this.#installer.getInstalled(key);
      plugins.push(record);
      skills.push(...await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key));
    }
    return Object.freeze({ plugins: Object.freeze(plugins), skills: Object.freeze(skills) });
  }

  async resolveSkill(pluginKey: string, name: string): Promise<PluginSkillRef> {
    const skills = await this.listSkills();
    const found = skills.find((entry) => entry.pluginKey === pluginKey && (entry.name === name || entry.id === name));
    if (!found) throw new Error(`Unknown plugin Skill: ${name} (${pluginKey})`);
    return found;
  }

  async loadSkill(pluginKey: string, name: string): Promise<{ readonly ref: PluginSkillRef; readonly body: string; readonly digest: string }> {
    const ref = await this.resolveSkill(pluginKey, name);
    const loaded = await loadPluginPrompt(ref.path);
    return { ref, body: loaded.body, digest: createHash("sha256").update(loaded.body).digest("hex") };
  }

  async readSkillResource(pluginKey: string, name: string, resourcePath: string): Promise<Uint8Array> {
    const ref = await this.resolveSkill(pluginKey, name);
    const loader = new SkillLoader();
    const loaded = await loader.load(dirname(ref.path));
    return loader.readResource(loaded, resourcePath);
  }

  async resolveCommand(id: string): Promise<PluginCommandRef> {
    const commands = await this.listCommands();
    const exact = commands.filter((entry) => entry.id === id || entry.name === id || entry.plugin === id);
    if (exact.length > 1) throw new Error(`Ambiguous plugin command: ${id}; choose one of ${exact.map((entry) => entry.id).join(", ")}`);
    const found = exact[0];
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
