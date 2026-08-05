import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "../skills/frontmatter.js";
import type {
  ConvertedMcpDeclaration,
  InspectedPlugin,
  PluginAgentRef,
  PluginCommandRef,
  PluginSkillRef,
  PluginComponentSummary,
  PluginSupportLevel,
} from "./types.js";

const UNSUPPORTED_COMPONENT_KINDS = new Set(["hooks", "lsp"]);

export async function inspectClaudePlugin(root: string, fallbackName?: string): Promise<InspectedPlugin> {
  const pluginRoot = resolve(root);
  const manifest = await readPluginManifest(pluginRoot);
  const name = manifest.name ?? fallbackName ?? basename(pluginRoot);
  const description = manifest.description ?? "";
  const components: PluginComponentSummary[] = [];
  const unsupportedReasons: string[] = [];

  const skillIds = await listSkillIds(pluginRoot);
  if (skillIds.length > 0) components.push({ kind: "skills", ids: skillIds, supported: true });

  const commandIds = await listMarkdownStemIds(resolve(pluginRoot, "commands"));
  if (commandIds.length > 0) components.push({ kind: "commands", ids: commandIds, supported: true });

  const agentIds = await listMarkdownStemIds(resolve(pluginRoot, "agents"));
  if (agentIds.length > 0) components.push({ kind: "agents", ids: agentIds, supported: true });

  if (await existsFile(resolve(pluginRoot, ".mcp.json"))) {
    components.push({ kind: "mcp", ids: [".mcp.json"], supported: true });
  }

  if (await existsDir(resolve(pluginRoot, "hooks")) || await existsFile(resolve(pluginRoot, "hooks", "hooks.json"))) {
    components.push({ kind: "hooks", ids: ["hooks"], supported: false });
    unsupportedReasons.push("hooks");
  }
  if (await existsFile(resolve(pluginRoot, ".lsp.json"))) {
    components.push({ kind: "lsp", ids: [".lsp.json"], supported: false });
    unsupportedReasons.push("lsp");
  }

  const support = classifySupport(components);
  return Object.freeze({
    name,
    description,
    root: pluginRoot,
    components: Object.freeze(components),
    support,
    unsupportedReasons: Object.freeze(unsupportedReasons),
  });
}

export async function listPluginCommands(
  pluginRoot: string,
  plugin: string,
  marketplace: string,
): Promise<readonly PluginCommandRef[]> {
  const refs: PluginCommandRef[] = [];
  const commandsRoot = resolve(pluginRoot, "commands");
  for (const name of await listMarkdownStemIds(commandsRoot)) {
    const path = resolve(commandsRoot, `${name}.md`);
    const { metadata, body: _body } = await readMarkdown(path);
    const description = typeof metadata.description === "string" ? metadata.description.trim() : name;
    refs.push(Object.freeze({
      id: commandId(marketplace, plugin, name),
      plugin,
      marketplace,
      name,
      description,
      path,
      kind: "command",
    }));
  }
  return Object.freeze(refs);
}

export async function listPluginSkills(
  pluginRoot: string,
  plugin: string,
  marketplace: string,
  pluginKey = `${plugin}@${marketplace}`,
): Promise<readonly PluginSkillRef[]> {
  const refs: PluginSkillRef[] = [];
  for (const { name: skillName, path } of await listSkillEntries(pluginRoot)) {
    const { metadata } = await readMarkdown(path);
    const userInvocable = metadata["user-invocable"] !== false;
    const modelInvocable = metadata["disable-model-invocation"] !== true;
    refs.push(Object.freeze({
      id: `${marketplace}:${plugin}:${skillName}`,
      pluginKey,
      plugin,
      marketplace,
      name: skillName,
      description: typeof metadata.description === "string" ? metadata.description.trim() : skillName,
      path,
      userInvocable,
      modelInvocable,
      invocationMode: invocationMode(userInvocable, modelInvocable),
      ...(typeof metadata.version === "string" && metadata.version.trim() ? { version: metadata.version.trim() } : {}),
    }));
  }
  return Object.freeze(refs);
}

export async function listPluginAgents(
  pluginRoot: string,
  plugin: string,
  marketplace: string,
): Promise<readonly PluginAgentRef[]> {
  const agentsRoot = resolve(pluginRoot, "agents");
  const refs: PluginAgentRef[] = [];
  for (const fileName of await listMarkdownFiles(agentsRoot)) {
    const path = resolve(agentsRoot, fileName);
    try {
      const { metadata } = await readMarkdown(path);
      const name = typeof metadata.name === "string" && metadata.name.trim()
        ? metadata.name.trim()
        : basename(fileName, ".md");
      const description = typeof metadata.description === "string" ? metadata.description.trim() : name;
      const model = typeof metadata.model === "string" ? metadata.model.trim() : undefined;
      const advisoryTools = parseTools(metadata.tools);
      refs.push(Object.freeze({
        id: `${marketplace}:${plugin}:${name}`,
        plugin,
        marketplace,
        name,
        description,
        path,
        ...(model === undefined ? {} : { model }),
        ...(advisoryTools === undefined ? {} : { advisoryTools: Object.freeze(advisoryTools) }),
      }));
    } catch {
      // Keep listing resilient: one broken agent frontmatter must not fail the whole catalog.
      refs.push(Object.freeze({
        id: `${marketplace}:${plugin}:${basename(fileName, ".md")}`,
        plugin,
        marketplace,
        name: basename(fileName, ".md"),
        description: `(unreadable agent frontmatter: ${basename(fileName)})`,
        path,
      }));
    }
  }
  return Object.freeze(refs);
}

export async function loadPluginPrompt(path: string): Promise<{ readonly body: string; readonly description: string }> {
  const { metadata, body } = await readMarkdown(path);
  const description = typeof metadata.description === "string" ? metadata.description.trim() : basename(path);
  return { body: body.trim(), description };
}

export async function convertClaudeMcpJson(raw: unknown, pluginName: string): Promise<readonly ConvertedMcpDeclaration[]> {
  if (!isRecord(raw)) throw new TypeError(".mcp.json must be an object");
  const servers = isRecord(raw.mcpServers) ? raw.mcpServers : raw;
  const converted: ConvertedMcpDeclaration[] = [];
  for (const [key, value] of Object.entries(servers)) {
    if (!isRecord(value)) throw new TypeError(`.mcp.json.${key} must be an object`);
    const warnings: string[] = [];
    const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : undefined;
    const command = optionalString(value.command);
    const url = optionalString(value.url);
    const args = value.args === undefined ? [] : stringArray(value.args, `.mcp.json.${key}.args`);
    const env = rewriteReferenceMap(value.env, warnings);
    const headers = rewriteReferenceMap(value.headers, warnings);
    const name = sanitizeMcpName(key, pluginName);
    if (url || type === "http" || type === "sse") {
      if (!url) throw new TypeError(`.mcp.json.${key} http/sse entry requires url`);
      converted.push(Object.freeze({
        name,
        transport: type === "sse" ? "sse" : "http",
        url,
        headers,
        env,
        warnings: Object.freeze(warnings),
      }));
      continue;
    }
    if (!command) throw new TypeError(`.mcp.json.${key} stdio entry requires command`);
    converted.push(Object.freeze({
      name,
      transport: "stdio",
      command,
      args: Object.freeze(args),
      env,
      headers,
      warnings: Object.freeze(warnings),
    }));
  }
  return Object.freeze(converted);
}

function classifySupport(components: readonly PluginComponentSummary[]): PluginSupportLevel {
  if (components.length === 0) return "unsupported";
  const hasSupported = components.some((entry) => entry.supported);
  const hasUnsupported = components.some((entry) => !entry.supported || UNSUPPORTED_COMPONENT_KINDS.has(entry.kind));
  if (!hasSupported) return "unsupported";
  if (hasUnsupported) return "partial";
  return "supported";
}

async function readPluginManifest(root: string): Promise<{ name?: string; description?: string; skills?: readonly string[] }> {
  const path = resolve(root, ".claude-plugin", "plugin.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(raw)) return {};
    const skills = raw.skills === undefined ? undefined : stringArray(raw.skills, "plugin.skills");
    return {
      ...(typeof raw.name === "string" ? { name: raw.name.trim() } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
      ...(skills === undefined ? {} : { skills: Object.freeze(skills) }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function listSkillIds(pluginRoot: string): Promise<string[]> {
  return (await listSkillEntries(pluginRoot)).map((entry) => entry.name);
}

async function listSkillEntries(pluginRoot: string): Promise<readonly { name: string; path: string }[]> {
  const manifest = await readPluginManifest(pluginRoot);
  if (manifest.skills !== undefined) {
    const entries: Array<{ name: string; path: string }> = [];
    const names = new Set<string>();
    for (const declared of manifest.skills) {
      const normalized = declared.replaceAll("\\", "/").replace(/^\.\//, "");
      const skillRoot = resolve(pluginRoot, normalized);
      const rel = relative(pluginRoot, skillRoot);
      if (!normalized || normalized.startsWith("/") || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
        throw new TypeError(`plugin.skills path escapes plugin root: ${declared}`);
      }
      const info = await lstat(skillRoot);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError(`plugin.skills entry must be a real directory: ${declared}`);
      const path = resolve(skillRoot, "SKILL.md");
      const skillInfo = await lstat(path);
      if (skillInfo.isSymbolicLink() || !skillInfo.isFile()) throw new TypeError(`plugin.skills entry is missing SKILL.md: ${declared}`);
      const name = basename(skillRoot);
      if (names.has(name)) throw new TypeError(`Duplicate plugin Skill: ${name}`);
      names.add(name);
      entries.push({ name, path });
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }
  const skillsRoot = resolve(pluginRoot, "skills");
  try {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    const ids: Array<{ name: string; path: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const path = resolve(skillsRoot, entry.name, "SKILL.md");
      if (await existsFile(path)) ids.push({ name: entry.name, path });
    }
    return ids.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listMarkdownStemIds(directory: string): Promise<string[]> {
  return (await listMarkdownFiles(directory)).map((name) => basename(name, ".md")).sort();
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && extname(entry.name).toLowerCase() === ".md")
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readMarkdown(path: string): Promise<{ metadata: Record<string, unknown>; body: string }> {
  const content = await readFile(path, "utf8");
  if (!(content.startsWith("---\n") || content.startsWith("---\r\n"))) {
    return { metadata: {}, body: content };
  }
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(content, path);
    return { metadata: parsed.metadata, body: parsed.body };
  } catch {
    // Claude agents often ship unquoted description scalars that contain "Key: value"
    // fragments (e.g. "Context: …"), which strict YAML rejects.
    return parseLenientFrontmatter(content, path);
  }
}

/**
 * Line-oriented frontmatter fallback for Claude plugin markdown that is not strict YAML.
 * Supports simple `key: value` lines and folded description values that contain colons.
 */
function parseLenientFrontmatter(
  content: string,
  label: string,
): { metadata: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match?.[1]) throw new TypeError(`${label} has unterminated or empty frontmatter`);
  const metadata: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const keyed = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!keyed) {
      index += 1;
      continue;
    }
    const key = keyed[1]!;
    let value = keyed[2] ?? "";
    index += 1;
    // Continue absorbing indented continuation lines into the current value.
    while (index < lines.length) {
      const next = lines[index]!;
      if (/^[A-Za-z][A-Za-z0-9_-]*:\s*/.test(next)) break;
      value = `${value}\n${next}`;
      index += 1;
    }
    metadata[key] = unescapeClaudeScalar(value.trim());
  }
  return { metadata, body: content.slice(match[0].length) };
}

function unescapeClaudeScalar(value: string): string {
  // Many Claude agent descriptions embed literal `\n` sequences rather than real newlines.
  return value
    .replaceAll("\\n", "\n")
    .replaceAll('\\"', '"')
    .replace(/^["']|["']$/g, "");
}

function commandId(marketplace: string, plugin: string, name: string): string {
  return `${marketplace}:${plugin}:${name}`;
}

function invocationMode(userInvocable: boolean, modelInvocable: boolean): PluginSkillRef["invocationMode"] {
  if (userInvocable && modelInvocable) return "user+model";
  if (userInvocable) return "user-only";
  if (modelInvocable) return "model-only";
  return "not-directly-invocable";
}

function sanitizeMcpName(key: string, pluginName: string): string {
  const candidate = key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (/^[a-z][a-z0-9-]{0,63}$/.test(candidate)) return candidate;
  const fallback = `${pluginName}-${candidate}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(fallback)) {
    throw new TypeError(`Cannot derive MCP declaration name from ${key}`);
  }
  return fallback.slice(0, 64);
}

function rewriteReferenceMap(value: unknown, warnings: string[]): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new TypeError("env/headers must be an object");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new TypeError(`${key} must be a string`);
    result[key] = rewriteReference(item, warnings);
  }
  return Object.freeze(result);
}

function rewriteReference(value: string, warnings: string[]): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, inner: string) => {
    if (/^(?:credential|env):[A-Za-z_][A-Za-z0-9_.-]*$/.test(inner)) return match;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return `\${env:${inner}}`;
    warnings.push(`unrecognized placeholder kept as-is: ${match}`);
    return match;
  });
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value.split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string" || !item.trim()) throw new TypeError("tools entries must be non-empty strings");
      return item.trim();
    });
  }
  throw new TypeError("tools must be a string or array");
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    return item;
  });
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function existsDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
