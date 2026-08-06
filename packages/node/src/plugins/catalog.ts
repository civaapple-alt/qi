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
  KnownMarketplace,
  MarketplaceSource,
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
  readonly needsConfirmation?: boolean;
}

interface PluginEnablementRecord {
  enabled: boolean;
  acceptedPin?: string;
  skills: string[];
  disabledSkills: string[];
}

interface PluginEnablementState {
  schemaVersion: 2;
  plugins: Record<string, PluginEnablementRecord>;
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
    const marketplace = await this.#registry.get(record.marketplace);
    if (!marketplace.enabled) throw new Error(`Marketplace ${record.marketplace} is disabled; enable it before enabling ${key}`);
    const enabled = await this.#readEnabled();
    const conflicting = Object.entries(enabled.plugins)
      .filter(([other, value]) => value.enabled && value.acceptedPin === record.pin && other !== key)
      .map(([other]) => other);
    for (const other of conflicting) {
      const installed = await this.#installer.getInstalled(other);
      if (installed.name === record.name) {
        throw new Error(`Plugin ${record.name} is already enabled as ${other}; disable it before enabling ${key}`);
      }
    }
    const refs = await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key);
    const previous = enabled.plugins[key];
    enabled.plugins[key] = {
      enabled: true,
      acceptedPin: record.pin,
      skills: (previous?.skills ?? []).filter((name) => refs.some((ref) => ref.name === name)),
      disabledSkills: (previous?.disabledSkills ?? []).filter((name) => refs.some((ref) => ref.name === name)),
    };
    await this.#writeEnabled(enabled);
    return { key, enabled: true, ...(previous && previous.acceptedPin !== record.pin ? { needsConfirmation: true } : {}) };
  }

  async disable(key: string): Promise<EnabledPluginState> {
    const enabled = await this.#readEnabled();
    const current = enabled.plugins[key] ?? { enabled: false, skills: [], disabledSkills: [] };
    enabled.plugins[key] = { ...current, enabled: false };
    await this.#writeEnabled(enabled);
    return { key, enabled: false };
  }

  async listEnabled(): Promise<readonly string[]> {
    const enabled = await this.#readEnabled();
    const active: string[] = [];
    for (const [key, value] of Object.entries(enabled.plugins)) {
      if (!value.enabled) continue;
      const record = await this.#installer.getInstalled(key).catch(() => undefined);
      if (record && value.acceptedPin === record.pin) active.push(key);
    }
    return active.sort();
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

  async listMarketplaces(): Promise<readonly KnownMarketplace[]> {
    return this.#registry.list();
  }

  /** Refresh a marketplace catalog (GitHub fetch/checkout or local metadata). Requires the source to be enabled. */
  async syncMarketplace(name: string): Promise<KnownMarketplace> {
    return this.#registry.sync(name);
  }

  async setMarketplaceEnabled(name: string, enabled: boolean): Promise<KnownMarketplace> {
    const marketplace = await this.#registry.setEnabled(name, enabled);
    if (!enabled) {
      // Marketplace disable is a user-visible batch stop: preserve immutable installs,
      // but do not leave any plugin from this source active for a later Run.
      for (const record of await this.#installer.listInstalled()) {
        if (record.marketplace === name) await this.disable(record.key);
      }
    }
    return marketplace;
  }

  /** User-operated marketplace registration; no plugin code is loaded or enabled. */
  async addMarketplace(name: string, source: MarketplaceSource): Promise<KnownMarketplace> {
    return this.#registry.add(name, source);
  }

  /** Install one marketplace plugin into Qi's immutable user cache without enabling it. */
  async installMarketplacePlugin(
    marketplaceName: string,
    pluginName: string,
  ): Promise<{ readonly record: InstalledPluginRecord; readonly mcpDeclarations: readonly string[] }> {
    const record = await this.#installer.install(marketplaceName, pluginName);
    const mcpDeclarations = await this.#installer.materializeMcpDeclarations(record.key);
    return Object.freeze({ record, mcpDeclarations: Object.freeze(mcpDeclarations) });
  }

  async previewMarketplacePlugin(
    marketplaceName: string,
    pluginName: string,
  ): Promise<{ readonly entry: MarketplacePluginEntry; readonly inspected: InspectedPlugin; readonly skills: readonly PluginSkillRef[] }> {
    const catalog = await this.#registry.loadCatalog(marketplaceName);
    const entry = catalog.plugins.find((candidate) => candidate.name === (catalog.renames[pluginName] ?? pluginName));
    if (!entry) throw new Error(`Plugin not found in marketplace ${marketplaceName}: ${pluginName}`);
    if (entry.source.kind !== "vendored") {
      throw new Error(`Preview requires installing remote plugin source: ${entry.name}`);
    }
    const marketplace = await this.#registry.get(marketplaceName);
    const root = resolve(marketplace.installLocation, entry.source.path);
    const inspected = await inspectClaudePlugin(root, entry.name);
    const skills = await listPluginSkills(root, entry.name, marketplaceName, `${entry.name}@${marketplaceName}`);
    return Object.freeze({ entry, inspected, skills });
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
      const pluginRefs = await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key);
      const selected = await this.#selectedSkillNames(record.key, pluginRefs);
      refs.push(...pluginRefs.filter((ref) => selected.has(ref.name)));
    }
    return filterByQuery(refs, query);
  }

  async listInstalledSkills(query = ""): Promise<readonly PluginSkillStatus[]> {
    const state = await this.#readEnabled();
    const statuses: PluginSkillStatus[] = [];
    for (const record of await this.#installer.listInstalled()) {
      const refs = await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key);
      const plugin = state.plugins[record.key];
      const pinMatches = plugin?.acceptedPin === record.pin;
      const pluginEnabled = Boolean(plugin?.enabled && pinMatches);
      const selected = plugin === undefined
        ? new Set<string>()
        : new Set(refs.filter((ref) => isSkillSelected(ref, plugin)).map((ref) => ref.name));
      for (const ref of refs) statuses.push(Object.freeze({
        ref,
        selected: selected.has(ref.name),
        enabled: pluginEnabled && selected.has(ref.name),
        ...(selected.has(ref.name) && !pluginEnabled
          ? { blockedReason: pinMatches ? "plugin-disabled" as const : "pin-confirmation" as const }
          : {}),
      }));
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
      const pluginRefs = await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key);
      const selected = await this.#selectedSkillNames(record.key, pluginRefs);
      skills.push(...pluginRefs.filter((ref) => selected.has(ref.name)));
    }
    return Object.freeze({ plugins: Object.freeze(plugins), skills: Object.freeze(skills) });
  }

  async resolveSkill(pluginKey: string, name: string): Promise<PluginSkillRef> {
    const skills = await this.listSkills();
    const found = skills.find((entry) => entry.pluginKey === pluginKey && (entry.name === name || entry.id === name));
    if (!found) throw new Error(`Unknown plugin Skill: ${name} (${pluginKey})`);
    return found;
  }

  /**
   * Resolves a Skill that the model may discover through the plugin_skill tool.
   * User-only Skills intentionally stay out of this path: their instructions are
   * supplied only after an explicit /skill: invocation.
   */
  async resolveModelSkill(pluginKey: string, name: string): Promise<PluginSkillRef> {
    const skills = await this.listSkills();
    const found = skills.find((entry) => entry.modelInvocable
      && entry.pluginKey === pluginKey
      && (entry.name === name || entry.id === name));
    if (!found) throw new Error(`Unknown model-invocable plugin Skill: ${name} (${pluginKey})`);
    return found;
  }

  async enableSkill(selector: string): Promise<PluginSkillStatus> {
    return this.#setSkill(selector, true);
  }

  async disableSkill(selector: string): Promise<PluginSkillStatus> {
    return this.#setSkill(selector, false);
  }

  async loadSkill(pluginKey: string, name: string): Promise<{ readonly ref: PluginSkillRef; readonly body: string; readonly digest: string }> {
    const ref = await this.resolveSkill(pluginKey, name);
    const loaded = await loadPluginPrompt(ref.path);
    return { ref, body: loaded.body, digest: createHash("sha256").update(loaded.body).digest("hex") };
  }

  async loadModelSkill(pluginKey: string, name: string): Promise<{ readonly ref: PluginSkillRef; readonly body: string; readonly digest: string }> {
    const ref = await this.resolveModelSkill(pluginKey, name);
    const loaded = await loadPluginPrompt(ref.path);
    return { ref, body: loaded.body, digest: createHash("sha256").update(loaded.body).digest("hex") };
  }

  async resolveSelectedSkill(selector: string): Promise<PluginSkillRef> {
    const skills = await this.listSkills();
    const exact = skills.filter((entry) => entry.id === selector);
    const short = skills.filter((entry) => entry.name === selector);
    const matches = exact.length > 0 ? exact : short;
    if (matches.length > 1) throw new Error(`Ambiguous plugin Skill: ${selector}; choose one of ${matches.map((entry) => entry.id).join(", ")}`);
    const found = matches[0];
    if (!found) throw new Error(`Unknown enabled plugin Skill: ${selector}`);
    return found;
  }

  async loadSelectedSkill(selector: string): Promise<{ readonly ref: PluginSkillRef; readonly body: string; readonly digest: string }> {
    const ref = await this.resolveSelectedSkill(selector);
    return this.loadSkill(ref.pluginKey, ref.name);
  }

  async readSkillResource(pluginKey: string, name: string, resourcePath: string): Promise<Uint8Array> {
    const ref = await this.resolveSkill(pluginKey, name);
    const loader = new SkillLoader();
    const loaded = await loader.load(dirname(ref.path));
    return loader.readResource(loaded, resourcePath);
  }

  async readModelSkillResource(pluginKey: string, name: string, resourcePath: string): Promise<Uint8Array> {
    const ref = await this.resolveModelSkill(pluginKey, name);
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

  async #selectedSkillNames(key: string, refs: readonly PluginSkillRef[]): Promise<Set<string>> {
    const state = await this.#readEnabled();
    const plugin = state.plugins[key];
    if (!plugin) return new Set();
    return new Set(refs.filter((ref) => isSkillSelected(ref, plugin)).map((ref) => ref.name));
  }

  async #setSkill(selector: string, selected: boolean): Promise<PluginSkillStatus> {
    const statuses = await this.listInstalledSkills();
    const found = statuses.find(({ ref }) => ref.id === selector || ref.name === selector);
    if (!found) throw new Error(`Unknown installed plugin Skill: ${selector}`);
    const record = await this.#installer.getInstalled(found.ref.pluginKey);
    const state = await this.#readEnabled();
    const plugin = state.plugins[record.key];
    if (!plugin?.enabled || plugin.acceptedPin !== record.pin) {
      throw new Error(`Enable plugin ${record.key} before changing Skill selection`);
    }
    const skills = new Set(plugin.skills);
    const disabledSkills = new Set(plugin.disabledSkills);
    if (found.ref.modelInvocable) {
      if (selected) disabledSkills.delete(found.ref.name); else disabledSkills.add(found.ref.name);
      skills.delete(found.ref.name);
    } else if (selected) {
      skills.add(found.ref.name);
    } else {
      skills.delete(found.ref.name);
    }
    state.plugins[record.key] = {
      ...plugin,
      skills: [...skills].sort(),
      disabledSkills: [...disabledSkills].sort(),
    };
    await this.#writeEnabled(state);
    return Object.freeze({ ref: found.ref, selected, enabled: selected });
  }

  async #readEnabled(): Promise<PluginEnablementState> {
    try {
      const raw = JSON.parse(await readFile(this.#enabledFile, "utf8")) as unknown;
      if (!isRecord(raw) || !isRecord(raw.plugins)) {
        throw new TypeError("enabled.json plugins must be an object");
      }
      if (raw.schemaVersion === 2) {
        const plugins: Record<string, PluginEnablementRecord> = {};
        for (const [key, value] of Object.entries(raw.plugins)) {
          if (!isRecord(value)) throw new TypeError(`enabled.json plugin ${key} must be an object`);
          plugins[key] = {
            enabled: Boolean(value.enabled),
            ...(typeof value.acceptedPin === "string" ? { acceptedPin: value.acceptedPin } : {}),
            skills: Array.isArray(value.skills) ? value.skills.filter((item): item is string => typeof item === "string") : [],
            disabledSkills: Array.isArray(value.disabledSkills)
              ? value.disabledSkills.filter((item): item is string => typeof item === "string")
              : [],
          };
        }
        return { schemaVersion: 2, plugins };
      }
      if (raw.schemaVersion !== 1) throw new TypeError("enabled.json schemaVersion must be 1 or 2");
      const installed = await this.#installer.listInstalled();
      const plugins: Record<string, PluginEnablementRecord> = {};
      for (const [key, value] of Object.entries(raw.plugins)) {
        const record = installed.find((entry) => entry.key === key);
        const refs = record ? await listPluginSkills(record.cachePath, record.name, record.marketplace, record.key) : [];
        plugins[key] = {
          enabled: Boolean(value),
          ...(record === undefined ? {} : { acceptedPin: record.pin }),
          skills: Boolean(value) ? refs.map((ref) => ref.name) : [],
          disabledSkills: [],
        };
      }
      const migrated = { schemaVersion: 2 as const, plugins };
      await this.#writeEnabled(migrated);
      return migrated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 2, plugins: {} };
      }
      throw error;
    }
  }

  async #writeEnabled(value: PluginEnablementState): Promise<void> {
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

function isSkillSelected(ref: PluginSkillRef, plugin: PluginEnablementRecord): boolean {
  if (ref.modelInvocable) return !plugin.disabledSkills.includes(ref.name);
  return plugin.skills.includes(ref.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
