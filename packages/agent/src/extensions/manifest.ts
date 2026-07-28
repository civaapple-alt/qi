export const DECLARATIVE_RESOURCE_KINDS = [
  "skills",
  "prompts",
  "themes",
  "agents",
  "workflows",
  "mcp",
] as const;

export type DeclarativeResourceKind = (typeof DECLARATIVE_RESOURCE_KINDS)[number];

export interface DeclarativeResourceContribution {
  readonly kind: DeclarativeResourceKind;
  readonly id: string;
  readonly path: string;
}

export interface QiPluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly resources: readonly DeclarativeResourceContribution[];
}

export interface LockedPackageSource {
  readonly type: "npm" | "git" | "local";
  readonly specifier: string;
  readonly resolved: string;
  readonly integrity?: string;
  readonly digest: `sha256-${string}`;
}

/**
 * Parse the public, declaration-only plugin contract.
 * It deliberately has no executable entry point and no authority fields.
 */
export function parseQiPluginManifest(value: unknown): QiPluginManifest {
  if (!isRecord(value)) throw new TypeError("Qi plugin manifest must be an object");
  if (value.schemaVersion !== 1) throw new TypeError("Qi plugin schemaVersion must be 1");
  const id = requiredId(value.id, "plugin id");
  const version = requiredString(value.version, "plugin version");
  if (!Array.isArray(value.resources)) throw new TypeError("Qi plugin resources must be an array");
  for (const forbidden of ["main", "module", "bin", "scripts", "capabilities", "authority"]) {
    if (forbidden in value) throw new TypeError(`Declarative Qi plugins must not define ${forbidden}`);
  }
  const seen = new Set<string>();
  const resources = value.resources.map((candidate, index) => {
    if (!isRecord(candidate)) throw new TypeError(`resources[${index}] must be an object`);
    if (!DECLARATIVE_RESOURCE_KINDS.includes(candidate.kind as DeclarativeResourceKind)) {
      throw new TypeError(`resources[${index}].kind is not supported`);
    }
    const resourceId = requiredId(candidate.id, `resources[${index}].id`);
    const path = requiredRelativePath(candidate.path, `resources[${index}].path`);
    const key = `${String(candidate.kind)}:${resourceId}`;
    if (seen.has(key)) throw new TypeError(`Duplicate plugin resource ${key}`);
    seen.add(key);
    return { kind: candidate.kind as DeclarativeResourceKind, id: resourceId, path };
  });
  return Object.freeze({ schemaVersion: 1, id, version, resources: Object.freeze(resources) });
}

function requiredId(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!/^[a-z][a-z0-9._-]{0,127}$/.test(text)) {
    throw new TypeError(`${label} must match /^[a-z][a-z0-9._-]{0,127}$/`);
  }
  return text;
}

function requiredRelativePath(value: unknown, label: string): string {
  const text = requiredString(value, label).replace(/\\/g, "/");
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text) ||
      text.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`${label} must be a normalized relative path`);
  }
  if (/\.(?:[cm]?[jt]s|node|exe|dll|so|dylib|bat|cmd|ps1|sh)$/i.test(text)) {
    throw new TypeError(`${label} points to executable content`);
  }
  return text;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
