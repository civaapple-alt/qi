import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parse } from "smol-toml";
import type { McpServerDeclaration, McpTransportKind } from "./types.js";

const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
const implicitLaunchers = new Set(["npx", "npm", "pnpm", "yarn", "bunx", "uvx", "pipx", "bash", "sh", "cmd", "powershell", "pwsh"]);
const secretName = /(?:authorization|api[_-]?key|token|secret|password|credential)/i;
const referencePattern = /^\$\{(?:credential|env):[A-Za-z_][A-Za-z0-9_.-]*\}$/;

export class McpDeclarationCatalog {
  readonly #workspaceRoot: string;
  readonly #workspaceDeclarations: string;
  readonly #userDeclarations: string;

  constructor(options: { workspaceRoot: string; userDeclarationsRoot: string }) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#workspaceDeclarations = resolve(this.#workspaceRoot, ".qi", "mcp");
    this.#userDeclarations = resolve(options.userDeclarationsRoot);
  }

  async discover(): Promise<readonly McpServerDeclaration[]> {
    const user = await discoverRoot(this.#userDeclarations, "user", this.#workspaceRoot);
    const workspace = await discoverRoot(this.#workspaceDeclarations, "workspace", this.#workspaceRoot);
    const selected = new Map(user.map((entry) => [entry.name, entry]));
    for (const entry of workspace) selected.set(entry.name, entry);
    return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<McpServerDeclaration> {
    const found = (await this.discover()).find((entry) => entry.name === name);
    if (!found) throw new Error(`Unknown MCP server declaration: ${name}`);
    return found;
  }
}

async function discoverRoot(root: string, scope: "workspace" | "user", workspaceRoot: string): Promise<McpServerDeclaration[]> {
  let info;
  try { info = await lstat(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`MCP declaration root must be a real directory: ${root}`);
  const canonical = await realpath(root);
  const declarations: McpServerDeclaration[] = [];
  for (const entry of await readdir(canonical, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !new Set([".toml", ".json"]).has(extname(entry.name).toLowerCase())) continue;
    const path = resolve(canonical, entry.name);
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error(`MCP declaration exceeds 256 KiB: ${path}`);
    const decoded = entry.name.endsWith(".json") ? JSON.parse(raw) : parse(raw);
    declarations.push(parseDeclaration(decoded, basename(entry.name, extname(entry.name)), path, scope, workspaceRoot));
  }
  return declarations;
}

export function parseDeclaration(value: unknown, fileName: string, sourcePath: string, scope: "workspace" | "user", workspaceRoot: string): McpServerDeclaration {
  if (!isRecord(value)) throw new TypeError(`MCP declaration must be an object: ${sourcePath}`);
  const name = stringValue(value.name ?? fileName, "name");
  if (!namePattern.test(name) || name !== fileName) throw new TypeError(`MCP declaration name must match filename: ${fileName}`);
  const transport = stringValue(value.transport, "transport") as McpTransportKind;
  if (!new Set<McpTransportKind>(["stdio", "http", "sse"]).has(transport)) throw new TypeError(`Unsupported MCP transport: ${transport}`);
  const command = optionalString(value.command, "command");
  const url = optionalString(value.url, "url");
  if (transport === "stdio") {
    if (!command) throw new TypeError("stdio MCP declarations require command");
    const leaf = command.replaceAll("\\", "/").split("/").at(-1)!.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
    if (implicitLaunchers.has(leaf)) throw new TypeError(`MCP stdio launcher ${leaf} is not allowed; install a pinned executable`);
    if (url) throw new TypeError("stdio MCP declarations cannot set url");
  } else {
    if (!url || command) throw new TypeError(`${transport} MCP declarations require url and cannot set command`);
    validateEndpoint(url, value.allow_private_network === undefined
      ? false
      : booleanValue(value.allow_private_network, "allow_private_network"));
  }
  const cwd = optionalString(value.cwd, "cwd");
  if (cwd && (cwd.startsWith("/") || /^[A-Za-z]:/.test(cwd) || cwd.split(/[\\/]/).includes(".."))) {
    throw new TypeError("MCP cwd must be Workspace-relative");
  }
  const oauthEnabled = value.oauth === undefined ? false : booleanValue(value.oauth, "oauth");
  if (oauthEnabled && transport === "stdio") throw new TypeError("OAuth is only supported for HTTP MCP transports");
  const oauthRedirectUrl = optionalString(value.oauth_redirect_url, "oauth_redirect_url");
  if (oauthEnabled && !oauthRedirectUrl) throw new TypeError("OAuth MCP declarations require oauth_redirect_url");
  if (oauthRedirectUrl) {
    const parsed = new URL(oauthRedirectUrl);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new TypeError("OAuth redirect URL requires HTTPS except loopback");
  }
  return {
    name, transport, scope, sourcePath,
    enabled: value.enabled === undefined ? true : booleanValue(value.enabled, "enabled"),
    ...(command === undefined ? {} : { command }),
    args: stringArray(value.args, "args"),
    ...(cwd === undefined ? {} : { cwd: resolve(workspaceRoot, cwd) }),
    ...(url === undefined ? {} : { url }),
    env: referenceMap(value.env, "env"),
    headers: referenceMap(value.headers, "headers"),
    ...(optionalString(value.credential_alias, "credential_alias") === undefined ? {} : { credentialAlias: optionalString(value.credential_alias, "credential_alias")! }),
    ...(oauthEnabled ? { oauth: { redirectUrl: oauthRedirectUrl!, scopes: stringArray(value.oauth_scopes, "oauth_scopes") } } : {}),
    connectTimeoutMs: boundedInteger(value.connect_timeout_ms, 15_000, 1_000, 120_000, "connect_timeout_ms"),
    callTimeoutMs: boundedInteger(value.call_timeout_ms, 60_000, 1_000, 120_000, "call_timeout_ms"),
    idleTimeoutMs: boundedInteger(value.idle_timeout_ms, 600_000, 10_000, 3_600_000, "idle_timeout_ms"),
  };
}

function validateEndpoint(value: string, allowPrivate: boolean): void {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new TypeError("MCP URL must not contain credentials or fragments");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("MCP HTTP endpoints require HTTPS except loopback");
  const privateIp = /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^169\.254\./.test(host);
  if (privateIp && !allowPrivate) throw new TypeError("Private-network MCP endpoints require allow_private_network=true");
}

function referenceMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new TypeError(`${label} must be a string map`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const text = stringValue(item, `${label}.${key}`);
    if ((secretName.test(key) || secretName.test(text)) && !referencePattern.test(text)) {
      throw new TypeError(`${label}.${key} looks secret-bearing; use a credential or env reference`);
    }
    result[key] = text;
  }
  return Object.freeze(result);
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || !value.every((entry) => typeof entry === "string" && entry.length <= 8_192)) throw new TypeError(`${label} must be a bounded string array`);
  return Object.freeze([...value]);
}
function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || (number as number) < min || (number as number) > max) throw new TypeError(`${label} must be ${min}-${max}`);
  return number as number;
}
function stringValue(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function optionalString(value: unknown, label: string): string | undefined { return value === undefined ? undefined : stringValue(value, label); }
function booleanValue(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
