import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "@earendil-works/pi-tui";

const MAX_SCAN = 2_000;
const MAX_SUGGESTIONS = 50;

interface Candidate {
  path: string;
  absolutePath: string;
  directory: boolean;
}

export class WorkspaceAutocompleteProvider implements AutocompleteProvider {
  readonly #inner: CombinedAutocompleteProvider;

  constructor(
    commands: readonly SlashCommand[],
    readonly workspaceRoot: string,
    readonly fdPath?: string,
    readonly preserveDraftCommands: ReadonlySet<string> = new Set(),
    readonly skillNames: readonly string[] = [],
    readonly pluginCommandIds: readonly string[] = [],
    readonly agentIds: readonly string[] = [],
    readonly pluginSkillIds: readonly string[] = [],
  ) {
    this.#inner = new CombinedAutocompleteProvider([...commands], workspaceRoot);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const skillPrefix = activeSkillPrefix(before);
    if (skillPrefix !== undefined) {
      const needle = skillPrefix.slice("/skill:".length).toLowerCase();
      const native = this.skillNames
        .filter((name) => name.toLowerCase().startsWith(needle))
        .slice(0, MAX_SUGGESTIONS)
        .map((name) => dynamicSlashItem("/skill:", name, "Active Skill"));
      const plugin = this.pluginSkillIds
        .filter((id) => id.toLowerCase().startsWith(needle) || id.toLowerCase().includes(needle))
        .slice(0, MAX_SUGGESTIONS)
        .map((id) => dynamicSlashItem("/skill:", id, "Enabled marketplace Skill"));
      const items = [...native, ...plugin].slice(0, MAX_SUGGESTIONS);
      return items.length === 0 ? null : { prefix: skillPrefix, items };
    }
    const pluginPrefix = activePrefixedSlash(before, "/plugin:");
    if (pluginPrefix !== undefined) {
      const needle = pluginPrefix.slice("/plugin:".length).toLowerCase();
      const items = this.pluginCommandIds
        .filter((id) => id.toLowerCase().startsWith(needle) || id.toLowerCase().includes(needle))
        .slice(0, MAX_SUGGESTIONS)
        .map((id) => dynamicSlashItem("/plugin:", id, "Enabled plugin command"));
      return items.length === 0 ? null : { prefix: pluginPrefix, items };
    }
    const agentPrefix = activePrefixedSlash(before, "/agent:");
    if (agentPrefix !== undefined) {
      const needle = agentPrefix.slice("/agent:".length).toLowerCase();
      const items = this.agentIds
        .filter((id) => id.toLowerCase().startsWith(needle) || id.toLowerCase().includes(needle))
        .slice(0, MAX_SUGGESTIONS)
        .map((id) => dynamicSlashItem("/agent:", id, "Enabled plugin agent"));
      return items.length === 0 ? null : { prefix: agentPrefix, items };
    }
    const prefix = atPrefix(before);
    if (prefix !== undefined) {
      const query = prefix.slice(1).replace(/^"|"$/g, "");
      const candidates = this.fdPath
        ? await fdCandidates(this.fdPath, this.workspaceRoot, query, options.signal)
            .catch(() => scanCandidates(this.workspaceRoot, options.signal))
        : await scanCandidates(this.workspaceRoot, options.signal);
      const ranked = rankCandidates(candidates, query).slice(0, MAX_SUGGESTIONS);
      return ranked.length === 0
        ? null
        : { prefix, items: ranked.map(mentionItem) };
    }
    return this.#inner.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const current = lines[cursorLine] ?? "";
    const beforePrefix = current.slice(0, cursorCol - prefix.length);
    const after = current.slice(cursorCol);
    if (
      prefix.startsWith("/")
      && cursorLine === 0
      && beforePrefix.length === 0
      && after.trim().length > 0
      && this.preserveDraftCommands.has(item.value)
    ) {
      return {
        lines: [`/${item.value}`, after, ...lines.slice(1)],
        cursorLine: 0,
        cursorCol: item.value.length + 1,
      };
    }
    // Prefixed dynamic slash values already include the leading `/` (unlike registry
    // slash commands, where CombinedAutocompleteProvider prepends `/` itself).
    if (prefix.startsWith("/skill:") || prefix.startsWith("/plugin:") || prefix.startsWith("/agent:")) {
      const next = [...lines];
      next[cursorLine] = `${beforePrefix}${item.value}${after}`;
      return { lines: next, cursorLine, cursorCol: beforePrefix.length + item.value.length };
    }
    if (prefix.startsWith("@")) {
      const next = [...lines];
      next[cursorLine] = `${beforePrefix}${item.value}${after}`;
      return { lines: next, cursorLine, cursorCol: beforePrefix.length + item.value.length };
    }
    return this.#inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

/** Validate and normalize explicit @ references without reading or injecting their content. */
export async function validateWorkspaceMentions(input: string, workspaceRoot: string): Promise<string> {
  const root = await realpath(resolve(workspaceRoot));
  // Unquoted mentions are path/token shaped (ASCII path chars). Quoted @"…" keeps spaces and
  // non-ASCII names. Stopping before CJK punctuation avoids swallowing `；` / `。` after @scope/pkg.
  const pattern = /(?<!\S)@(?:"([^"\r\n]+)"|([A-Za-z0-9._~+/-][A-Za-z0-9._~+/\\-]*))/g;
  let output = "";
  let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? "";
    if (!raw || raw.includes("://")) continue;
    const normalizedRaw = raw.replaceAll("\\", "/").replace(/\/+$/, "");
    const absolute = resolve(root, normalizedRaw);
    assertMentionScope(root, absolute, normalizedRaw);
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      // npm-style @scope/pkg (e.g. @memo/shared-types) collides with @path mentions.
      // Leave absent scoped-package lookalikes as plain text so continue messages can submit.
      if (await isAbsentScopedPackageStyle(root, normalizedRaw)) continue;
      throw new Error(`Workspace mention does not exist: @${raw}`);
    }
    if (info.isSymbolicLink()) throw new Error(`Workspace mention must not be a symbolic link: @${raw}`);
    const canonical = await realpath(absolute);
    if (canonical !== absolute) throw new Error(`Workspace mention traverses a symbolic link: @${raw}`);
    const relativePath = relative(root, absolute).split(sep).join("/") || ".";
    const value = `${relativePath}${info.isDirectory() ? "/" : ""}`;
    const rendered = value.includes(" ") ? `@"${value}"` : `@${value}`;
    output += input.slice(cursor, match.index) + rendered;
    cursor = (match.index ?? 0) + match[0].length;
  }
  return `${output}${input.slice(cursor)}`;
}

function atPrefix(text: string): string | undefined {
  const match = /(?:^|\s)(@(?:"[^"]*|[^\s]*))$/.exec(text);
  return match?.[1];
}

function activeSkillPrefix(text: string): string | undefined {
  const match = /(?:^|\s)(\/skill:[a-z0-9:_-]*)$/i.exec(text);
  return match?.[1];
}

function activePrefixedSlash(text: string, prefix: "/plugin:" | "/agent:"): string | undefined {
  const escaped = prefix.replace(":", "\\:");
  const match = new RegExp(`(?:^|\\s)(${escaped}[a-z0-9:_-]*)$`, "i").exec(text);
  return match?.[1];
}

/** Keep the inserted value exact while giving long names a readable primary-column label. */
function dynamicSlashItem(prefix: "/skill:" | "/plugin:" | "/agent:", id: string, description: string): AutocompleteItem {
  const value = `${prefix}${id}`;
  if (value.length <= 32) return { value, label: value, description };
  const tail = id.slice(id.lastIndexOf(":") + 1);
  return {
    value,
    label: `${prefix}${tail}`,
    description: `${id} · ${description}`,
  };
}

async function fdCandidates(
  fdPath: string,
  root: string,
  query: string,
  signal: AbortSignal,
): Promise<Candidate[]> {
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    execFile(fdPath, [
      "--color", "never",
      "--hidden",
      "--max-results", String(MAX_SCAN),
      "--exclude", ".git",
      "--exclude", ".qi",
      "--type", "f",
      "--type", "d",
      query || ".",
      ".",
    ], { cwd: root, windowsHide: true, signal }, (error, result) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        reject(error);
        return;
      }
      resolveOutput(result ?? "");
    });
  });
  const candidates: Candidate[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const path = line.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (protectedPath(path)) continue;
    const absolutePath = resolve(root, path);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (!info || info.isSymbolicLink()) continue;
    candidates.push({ path, absolutePath, directory: info.isDirectory() });
  }
  return candidates;
}

async function scanCandidates(root: string, signal: AbortSignal): Promise<Candidate[]> {
  const ignores = await rootIgnorePatterns(root);
  const candidates: Candidate[] = [];
  const stack = [""];
  while (stack.length > 0 && candidates.length < MAX_SCAN && !signal.aborted) {
    const directory = stack.pop()!;
    const absoluteDirectory = resolve(root, directory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (candidates.length >= MAX_SCAN || signal.aborted) break;
      const path = `${directory ? `${directory}/` : ""}${entry.name}`.replaceAll("\\", "/");
      if (protectedPath(path) || ignored(path, entry.isDirectory(), ignores)) continue;
      const absolutePath = resolve(root, path);
      if (entry.isSymbolicLink()) continue;
      candidates.push({ path, absolutePath, directory: entry.isDirectory() });
      if (entry.isDirectory()) stack.push(path);
    }
  }
  return candidates;
}

async function rootIgnorePatterns(root: string): Promise<string[]> {
  const content = await readFile(resolve(root, ".gitignore"), "utf8").catch(() => "");
  return content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("!") && !line.startsWith("#"));
}

function ignored(path: string, directory: boolean, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (!normalized) return false;
    if (!normalized.includes("*")) {
      return path === normalized || path.startsWith(`${normalized}/`) || path.split("/").includes(normalized);
    }
    const expression = new RegExp(`^${normalized
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*")}${directory ? "(?:/.*)?$" : "$"}`);
    return expression.test(path);
  });
}

function rankCandidates(candidates: readonly Candidate[], query: string): Candidate[] {
  const needle = query.toLowerCase();
  return [...candidates]
    .map((candidate) => {
      const path = candidate.path.toLowerCase();
      const name = basename(path);
      const score = !needle ? 10
        : name === needle ? 100
        : name.startsWith(needle) ? 80
        : name.includes(needle) ? 50
        : path.includes(needle) ? 30
        : 0;
      return { candidate, score: score + (candidate.directory && score ? 10 : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.candidate.path.localeCompare(right.candidate.path))
    .map((entry) => entry.candidate);
}

function mentionItem(candidate: Candidate): AutocompleteItem {
  const path = `${candidate.path}${candidate.directory ? "/" : ""}`;
  return {
    value: path.includes(" ") ? `@"${path}"` : `@${path}`,
    label: `${basename(candidate.path)}${candidate.directory ? "/" : ""}`,
    description: candidate.absolutePath,
  };
}

function protectedPath(path: string): boolean {
  return path.split("/").some((segment) => segment === ".git" || segment === ".qi");
}

function assertMentionScope(root: string, absolute: string, raw: string): void {
  if (protectedPath(raw)) throw new Error(`Workspace mention targets a protected path: @${raw}`);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Workspace mention escapes the current Workspace: @${raw}`);
  }
}

/**
 * True when `scope/name` looks like an npm scoped package and `scope` is not a Workspace root entry.
 * File-like second segments (e.g. guide.md) stay path mentions and still fail when missing.
 */
async function isAbsentScopedPackageStyle(root: string, normalizedRaw: string): Promise<boolean> {
  const parts = normalizedRaw.split("/");
  if (parts.length !== 2) return false;
  const [scope, name] = parts;
  if (!scope || !name) return false;
  if (!/^[a-z0-9][\w.~-]*$/i.test(scope) || !/^[a-z0-9][\w.~-]*$/i.test(name)) return false;
  if (/\.[a-z0-9]{1,12}$/i.test(name)) return false;
  const scopeInfo = await lstat(resolve(root, scope)).catch(() => undefined);
  return scopeInfo === undefined;
}
