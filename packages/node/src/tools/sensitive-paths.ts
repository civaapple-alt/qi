import { basename, posix } from "node:path";
import { ToolFailure, type ToolExecutionContext } from "@civaapple/qi-agent/tools";

export interface SensitivePathPolicy {
  /** Extra relative path or basename globs treated as sensitive. */
  readonly extra?: readonly string[];
  /** Relative path or basename globs that must never be treated as sensitive. */
  readonly exclude?: readonly string[];
}

const exampleSuffixes = [".example", ".sample", ".template", ".dist"];

/** Default basename / relative-path patterns for Workspace content that needs a human grant. */
const defaultSensitiveBasenames = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.staging",
  "credentials.json",
  "credentials.xml",
  "service-account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "application-local.properties",
  "application-local.yml",
  "application-local.yaml",
  "application-secret.properties",
  "application-secret.yml",
  "application-secret.yaml",
  "secrets.yml",
  "secrets.yaml",
  "secrets.toml",
  "secrets.json",
] as const;

const defaultSensitiveExtensions = [".pem", ".p12", ".pfx", ".jks", ".keystore"] as const;

/**
 * Normalize a Workspace-relative path for grant storage and comparison.
 * Mount paths (`mount:<id>/…`) are never classified as project-sensitive grants.
 */
export function normalizeWorkspaceRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

export function isSensitiveWorkspacePath(
  relativePath: string,
  policy: SensitivePathPolicy = {},
): boolean {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (normalized.startsWith("mount:")) return false;
  if (matchesAny(normalized, policy.exclude ?? [])) return false;
  if (matchesAny(normalized, policy.extra ?? [])) return true;

  const name = basename(normalized);
  const lower = name.toLowerCase();

  if (exampleSuffixes.some((suffix) => lower.endsWith(suffix))) return false;
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if ((defaultSensitiveBasenames as readonly string[]).includes(lower)) return true;
  if (defaultSensitiveExtensions.some((ext) => lower.endsWith(ext))) return true;
  return false;
}

export function sensitivePathGrantsFromContext(context: ToolExecutionContext): readonly string[] {
  const live = context.getSensitivePathGrants?.() ?? context.sensitivePathGrants ?? [];
  return live.map(normalizeWorkspaceRelativePath);
}

export function sensitivePathPolicyFromContext(context: ToolExecutionContext): SensitivePathPolicy {
  return context.sensitivePathPolicy ?? {};
}

/**
 * Fail closed before content tools read or mutate a sensitive Workspace path that lacks a grant.
 * `relativePath` should be the tool-facing Workspace-relative path (not an absolute OS path).
 */
export function assertSensitiveContentAllowed(
  relativePath: string,
  context: ToolExecutionContext,
): void {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (normalized.startsWith("mount:")) return;
  const policy = sensitivePathPolicyFromContext(context);
  if (!isSensitiveWorkspacePath(normalized, policy)) return;
  const grants = new Set(sensitivePathGrantsFromContext(context));
  if (grants.has(normalized)) return;
  throw new ToolFailure(
    "SENSITIVE_PATH_GRANT_REQUIRED",
    `Sensitive path requires an explicit human grant before its content may reach the model: ${normalized}`,
    { path: normalized, kind: "sensitive" as const },
  );
}

function matchesAny(relativePath: string, patterns: readonly string[]): boolean {
  const name = basename(relativePath).toLowerCase();
  const pathLower = relativePath.toLowerCase();
  for (const pattern of patterns) {
    const candidate = normalizeWorkspaceRelativePath(pattern).toLowerCase();
    if (!candidate || candidate === ".") continue;
    if (candidate === pathLower || candidate === name) return true;
    if (simpleGlobMatch(pathLower, candidate) || simpleGlobMatch(name, candidate)) return true;
  }
  return false;
}

/** Minimal `*` / `**` matcher for policy globs; exact paths remain preferred. */
function simpleGlobMatch(value: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return value === pattern;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/** Re-export posix join helper for tests that compose nested sensitive paths. */
export function joinWorkspaceRelative(...parts: string[]): string {
  return normalizeWorkspaceRelativePath(posix.join(...parts.map((part) => part.replace(/\\/g, "/"))));
}
