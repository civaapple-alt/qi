import type { MarketplaceCatalog, MarketplacePluginEntry, PluginSource } from "./types.js";

export function parseMarketplaceCatalog(value: unknown): MarketplaceCatalog {
  if (!isRecord(value)) throw new TypeError("marketplace.json must be an object");
  const name = requiredString(value.name, "marketplace.name");
  const description = optionalString(value.description);
  const renames = stringMap(value.renames, "marketplace.renames");
  if (!Array.isArray(value.plugins)) throw new TypeError("marketplace.plugins must be an array");
  const plugins = value.plugins.map((entry, index) => parsePluginEntry(entry, index));
  return Object.freeze({
    name,
    ...(description === undefined ? {} : { description }),
    renames: Object.freeze(renames),
    plugins: Object.freeze(plugins),
  });
}

export function searchMarketplacePlugins(
  catalog: MarketplaceCatalog,
  query: string,
): readonly MarketplacePluginEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return catalog.plugins;
  return catalog.plugins.filter((plugin) => {
    const haystack = [
      plugin.name,
      plugin.displayName ?? "",
      plugin.description,
      plugin.category ?? "",
      plugin.author ?? "",
      ...(plugin.tags ?? []),
    ].join("\n").toLowerCase();
    return haystack.includes(needle);
  });
}

export function resolveMarketplaceName(catalog: MarketplaceCatalog, requested: string): string {
  return catalog.renames[requested] ?? requested;
}

function parsePluginEntry(value: unknown, index: number): MarketplacePluginEntry {
  if (!isRecord(value)) throw new TypeError(`marketplace.plugins[${index}] must be an object`);
  const name = requiredString(value.name, `plugins[${index}].name`);
  const description = requiredString(value.description, `plugins[${index}].description`);
  const source = parseSource(value.source, index);
  const author = isRecord(value.author) ? optionalString(value.author.name) : optionalString(value.author);
  const tags = value.tags === undefined ? undefined : stringArray(value.tags, `plugins[${index}].tags`);
  const skills = value.skills === undefined ? undefined : stringArray(value.skills, `plugins[${index}].skills`);
  const category = optionalString(value.category);
  const homepage = optionalString(value.homepage);
  const displayName = optionalString(value.displayName);
  const entry: MarketplacePluginEntry = {
    name,
    description,
    source,
    ...(category === undefined ? {} : { category }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(author === undefined ? {} : { author }),
    ...(tags === undefined ? {} : { tags: Object.freeze(tags) }),
    ...(value.strict === undefined ? {} : { strict: Boolean(value.strict) }),
    ...(skills === undefined ? {} : { skills: Object.freeze(skills) }),
    ...(displayName === undefined ? {} : { displayName }),
  };
  return Object.freeze(entry);
}

function parseSource(value: unknown, index: number): PluginSource {
  if (typeof value === "string") {
    const path = value.trim().replaceAll("\\", "/");
    if (!path.startsWith("./")) throw new TypeError(`plugins[${index}].source path must be relative`);
    return Object.freeze({ kind: "vendored", path });
  }
  if (!isRecord(value)) throw new TypeError(`plugins[${index}].source must be a string or object`);
  const kind = requiredString(value.source, `plugins[${index}].source.source`);
  if (kind !== "git-subdir" && kind !== "url" && kind !== "github" && kind !== "npm") {
    throw new TypeError(`plugins[${index}].source.source is unsupported: ${kind}`);
  }
  const url = optionalString(value.url);
  const path = optionalString(value.path);
  const ref = optionalString(value.ref);
  const sha = optionalString(value.sha);
  const repo = optionalString(value.repo);
  const source: PluginSource = {
    kind,
    ...(url === undefined ? {} : { url }),
    ...(path === undefined ? {} : { path }),
    ...(ref === undefined ? {} : { ref }),
    ...(sha === undefined ? {} : { sha }),
    ...(repo === undefined ? {} : { repo }),
  };
  return Object.freeze(source);
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || !item.trim()) throw new TypeError(`${label}.${key} must be a non-empty string`);
    result[key] = item.trim();
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new TypeError(`${label}[${index}] must be a non-empty string`);
    return item.trim();
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError("expected string");
  const text = value.trim();
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
