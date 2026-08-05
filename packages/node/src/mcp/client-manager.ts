import type { Stream } from "node:stream";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { minimalHostEnvironment } from "../workspace/process.js";
import { resolveShellExecutable } from "../tools/builtins.js";
import type { McpDeclarationCatalog } from "./declarations.js";
import { candidateFromRaw, fingerprintMcpValue, McpReviewStore } from "./review-store.js";
import type { McpBinding, McpCandidateSnapshot, McpServerDeclaration, McpServerStatus } from "./types.js";

export interface McpCredentialResolver {
  resolve(alias: string): Promise<string | undefined>;
}

export interface McpOAuthProviderFactory {
  create(server: McpServerDeclaration): Promise<OAuthClientProvider | undefined>;
  validateCallbackState?(server: string, state: string): Promise<void>;
  invalidate?(server: string): Promise<void>;
}

interface LiveConnection {
  declaration: McpServerDeclaration;
  client: Client;
  transport: Transport;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  stderr: string;
  transportIdentity: Readonly<Record<string, unknown>>;
}

const jsonSchemaValidator = new AjvJsonSchemaValidator();

export class McpConnectionManager {
  readonly #catalog: McpDeclarationCatalog;
  readonly #reviews: McpReviewStore;
  readonly #credentials: McpCredentialResolver | undefined;
  readonly #oauth: McpOAuthProviderFactory | undefined;
  readonly #workspaceRoot: string;
  readonly #connections = new Map<string, LiveConnection>();
  readonly #pendingAuth = new Map<string, Transport>();
  readonly #statuses = new Map<string, McpServerStatus>();

  constructor(options: {
    catalog: McpDeclarationCatalog;
    reviews: McpReviewStore;
    workspaceRoot: string;
    credentials?: McpCredentialResolver;
    oauth?: McpOAuthProviderFactory;
  }) {
    this.#catalog = options.catalog;
    this.#reviews = options.reviews;
    this.#workspaceRoot = options.workspaceRoot;
    this.#credentials = options.credentials;
    this.#oauth = options.oauth;
  }

  async statuses(): Promise<readonly McpServerStatus[]> {
    const document = await this.#reviews.read();
    return Promise.all((await this.#catalog.discover()).map(async (declaration) => {
      const current = this.#statuses.get(declaration.name);
      const counts = {
        candidateCount: candidateCount(document.snapshots[declaration.name]),
        bindingCount: Object.values(document.bindings).filter((binding) => binding.server === declaration.name && binding.state === "bound").length,
      };
      const base: McpServerStatus = current
        ? { ...current, ...counts }
        : {
          name: declaration.name,
          transport: declaration.transport,
          status: declaration.enabled ? "quarantined" : "disabled",
          scope: declaration.scope,
          ...counts,
        };
      const { marketplace: _priorMarketplace, ...withoutMarketplace } = base;
      return { ...withoutMarketplace, ...statusOrigin(declaration) };
    }));
  }

  async refresh(server: string): Promise<{ snapshot: McpCandidateSnapshot; drifted: readonly string[] }> {
    const connection = await this.#connect(server);
    try {
      const capabilities = connection.client.getServerCapabilities();
      const [tools, resources, resourceTemplates, prompts] = await Promise.all([
        capabilities?.tools
          ? pagedList((cursor) => connection.client.listTools(cursor ? { cursor } : undefined), "tools")
          : Promise.resolve([]),
        capabilities?.resources
          ? pagedList((cursor) => connection.client.listResources(cursor ? { cursor } : undefined), "resources")
          : Promise.resolve([]),
        capabilities?.resources
          ? pagedList((cursor) => connection.client.listResourceTemplates(cursor ? { cursor } : undefined), "resourceTemplates")
          : Promise.resolve([]),
        capabilities?.prompts
          ? pagedList((cursor) => connection.client.listPrompts(cursor ? { cursor } : undefined), "prompts")
          : Promise.resolve([]),
      ]);
      const instructions = connection.client.getInstructions();
      const snapshot: McpCandidateSnapshot = {
        server,
        capturedAt: new Date().toISOString(),
        ...(connection.client.getServerVersion() === undefined ? {} : { serverInfo: asRecord(connection.client.getServerVersion()!) }),
        ...(instructions === undefined ? {} : { instructions, instructionsFingerprint: fingerprintMcpValue(instructions) }),
        transportIdentity: connection.transportIdentity,
        tools: tools.map((entry) => candidateFromRaw("tool", asRecord(entry))),
        resources: resources.map((entry) => candidateFromRaw("resource", asRecord(entry))),
        resourceTemplates: resourceTemplates.map((entry) => candidateFromRaw("resource-template", asRecord(entry))),
        prompts: prompts.map((entry) => candidateFromRaw("prompt", asRecord(entry))),
      };
      const recorded = await this.#reviews.recordSnapshot(snapshot);
      this.#setStatus(connection.declaration, recorded.drifted.length ? "drifted" : "ready", recorded.drifted.length ? `${recorded.drifted.length} binding(s) changed` : undefined);
      this.#touch(connection);
      return recorded;
    } catch (error) {
      this.#setStatus(connection.declaration, "failed", errorMessage(error));
      throw error;
    }
  }

  async callTool(binding: McpBinding, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.#assertCurrent(binding);
    const candidate = await this.#candidate(binding);
    const inputSchema = candidate?.raw.inputSchema;
    if (isRecord(inputSchema) && !jsonSchemaValidator.getValidator(inputSchema)(args).valid) {
      throw new McpSchemaError(binding.server, binding.name, "input");
    }
    const connection = await this.#connect(binding.server);
    const result = await connection.client.callTool({ name: binding.name, arguments: args }, { ...(signal === undefined ? {} : { signal }), timeout: connection.declaration.callTimeoutMs });
    this.#touch(connection);
    if (result.isError) throw new McpRemoteToolError(binding.server, binding.name, result);
    const outputSchema = candidate?.raw.outputSchema;
    if (isRecord(outputSchema) && !jsonSchemaValidator.getValidator(outputSchema)(result.structuredContent).valid) {
      throw new McpSchemaError(binding.server, binding.name, "output");
    }
    return result;
  }

  async readResource(binding: McpBinding, uri: string, signal?: AbortSignal): Promise<unknown> {
    await this.#assertCurrent(binding);
    const connection = await this.#connect(binding.server);
    const result = await this.#readWithReconnect(binding.server, async (active) => active.client.readResource(
      { uri },
      { ...(signal === undefined ? {} : { signal }), timeout: active.declaration.callTimeoutMs },
    ), connection);
    this.#touch(connection);
    return result;
  }

  async getPrompt(binding: McpBinding, args: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    await this.#assertCurrent(binding);
    const connection = await this.#connect(binding.server);
    const result = await this.#readWithReconnect(binding.server, async (active) => active.client.getPrompt(
      { name: binding.name, arguments: args },
      { ...(signal === undefined ? {} : { signal }), timeout: active.declaration.callTimeoutMs },
    ), connection);
    this.#touch(connection);
    return result;
  }

  async getInstructions(binding: McpBinding): Promise<string> {
    await this.#assertCurrent(binding);
    const connection = await this.#connect(binding.server);
    const instructions = connection.client.getInstructions();
    if (instructions === undefined || fingerprintMcpValue(instructions) !== binding.fingerprint) throw new McpBindingDriftError(binding.server, "instructions", binding.name);
    this.#touch(connection);
    return instructions;
  }

  async close(server?: string): Promise<void> {
    const targets = server ? [...this.#connections.entries()].filter(([name]) => name === server) : [...this.#connections.entries()];
    await Promise.all(targets.map(async ([name, connection]) => {
      if (connection.idleTimer) clearTimeout(connection.idleTimer);
      this.#connections.delete(name);
      await connection.client.close().catch(() => undefined);
      this.#setStatus(connection.declaration, "idle");
    }));
  }

  async finishOAuthCallback(server: string, callbackUrl: string): Promise<void> {
    const declaration = await this.#catalog.get(server);
    if (!declaration.oauth) throw new Error(`MCP server ${server} is not configured for OAuth`);
    const callback = new URL(callbackUrl);
    if (callback.origin !== new URL(declaration.oauth.redirectUrl).origin || callback.pathname !== new URL(declaration.oauth.redirectUrl).pathname) {
      throw new Error("MCP OAuth callback URL does not match the reviewed redirect URL");
    }
    const state = callback.searchParams.get("state");
    if (!state) throw new Error("MCP OAuth callback is missing state");
    await this.#oauth?.validateCallbackState?.(server, state);
    const transport = this.#pendingAuth.get(server) as Transport & { finishAuth?(params: URLSearchParams): Promise<void> } | undefined;
    if (!transport?.finishAuth) throw new Error(`MCP server ${server} has no pending OAuth flow`);
    await transport.finishAuth(callback.searchParams);
    this.#pendingAuth.delete(server);
    await this.refresh(server);
  }

  async logout(server: string): Promise<void> {
    await this.close(server);
    const pending = this.#pendingAuth.get(server);
    this.#pendingAuth.delete(server);
    await pending?.close?.().catch(() => undefined);
    await this.#oauth?.invalidate?.(server);
  }

  async #connect(server: string): Promise<LiveConnection> {
    const existing = this.#connections.get(server);
    if (existing) { this.#touch(existing); return existing; }
    const declaration = await this.#catalog.get(server);
    if (!declaration.enabled) throw new Error(`MCP server ${server} is disabled`);
    this.#setStatus(declaration, "connecting");
    let built: { transport: Transport; stderr?: Stream; identity: Readonly<Record<string, unknown>> } | undefined;
    let client: Client | undefined;
    try {
      built = await this.#transport(declaration);
      client = new Client(
        { name: "qi", version: "0.7.3" },
        { versionNegotiation: { mode: "auto" }, enforceStrictCapabilities: true },
      );
      const connection: LiveConnection = { declaration, client, transport: built.transport, transportIdentity: built.identity, lastUsed: Date.now(), stderr: "" };
      if (built.stderr) built.stderr.on("data", (chunk: Buffer | string) => { connection.stderr = `${connection.stderr}${String(chunk)}`.slice(-64 * 1024); });
      const refreshAfterChange = () => { void this.refresh(server).catch(() => undefined); };
      client.setNotificationHandler("notifications/tools/list_changed", refreshAfterChange);
      client.setNotificationHandler("notifications/resources/list_changed", refreshAfterChange);
      client.setNotificationHandler("notifications/prompts/list_changed", refreshAfterChange);
      await withTimeout(client.connect(built.transport), declaration.connectTimeoutMs, `MCP ${server} connect`);
      this.#connections.set(server, connection);
      this.#setStatus(declaration, "ready");
      this.#touch(connection);
      return connection;
    } catch (error) {
      if (declaration.oauth && built && /unauthor|authorization|redirect/i.test(errorMessage(error))) {
        this.#pendingAuth.set(server, built.transport);
      } else {
        await client?.close().catch(() => undefined);
        await built?.transport.close?.().catch(() => undefined);
      }
      this.#setStatus(declaration, /unauthor/i.test(errorMessage(error)) ? "needs-auth" : "failed", errorMessage(error));
      throw error;
    }
  }

  async #transport(declaration: McpServerDeclaration): Promise<{ transport: Transport; stderr?: Stream; identity: Readonly<Record<string, unknown>> }> {
    const oauth = await this.#oauth?.create(declaration);
    const bearer = declaration.credentialAlias ? await this.#credentials?.resolve(declaration.credentialAlias) : undefined;
    const authProvider = oauth ?? (bearer ? { token: async () => bearer } : undefined);
    if (declaration.transport === "stdio") {
      const command = await resolveShellExecutable(declaration.command!, this.#workspaceRoot);
      const canonicalCommand = await realpath(command);
      const commandInfo = await lstat(canonicalCommand);
      if (commandInfo.isSymbolicLink() || !commandInfo.isFile()) throw new Error(`MCP stdio command must be a regular file: ${canonicalCommand}`);
      const env = minimalHostEnvironment({
        ...await resolveReferenceMap(declaration.env, this.#credentials),
        NO_COLOR: "1",
        QI_MCP_SERVER: declaration.name,
      });
      const transport = new StdioClientTransport({ command, args: [...declaration.args], env: env as Record<string, string>, cwd: declaration.cwd ?? this.#workspaceRoot, stderr: "pipe", maxBufferSize: 8 * 1024 * 1024 });
      return {
        transport,
        ...(transport.stderr === null ? {} : { stderr: transport.stderr }),
        identity: {
          transport: "stdio",
          command: canonicalCommand,
          args: [...declaration.args],
          size: commandInfo.size,
          sha256: await sha256File(canonicalCommand),
        },
      };
    }
    const headers = await resolveReferenceMap(declaration.headers, this.#credentials);
    const options = {
      ...(authProvider === undefined ? {} : { authProvider }),
      requestInit: { headers, redirect: "error" as const },
      onInsufficientScope: "throw" as const,
      maxStepUpRetries: 0,
    };
    return { transport: declaration.transport === "sse"
      ? new SSEClientTransport(new URL(declaration.url!), options)
      : new StreamableHTTPClientTransport(new URL(declaration.url!), options), identity: { transport: declaration.transport, url: declaration.url } };
  }

  async #assertCurrent(binding: McpBinding): Promise<void> {
    if (binding.state !== "bound") throw new McpBindingDriftError(binding.server, binding.kind, binding.name);
    const document = await this.#reviews.read();
    const current = Object.values(document.bindings).find((entry) => entry.server === binding.server && entry.kind === binding.kind && entry.name === binding.name);
    if (!current || current.state !== "bound" || current.fingerprint !== binding.fingerprint) throw new McpBindingDriftError(binding.server, binding.kind, binding.name);
  }

  async #candidate(binding: McpBinding) {
    const snapshot = (await this.#reviews.read()).snapshots[binding.server];
    return binding.kind === "tool" ? snapshot?.tools.find((entry) => entry.name === binding.name) : undefined;
  }

  async #readWithReconnect<T>(server: string, operation: (connection: LiveConnection) => Promise<T>, connection: LiveConnection): Promise<T> {
    try {
      return await operation(connection);
    } catch (error) {
      if (!isRetryableConnectionError(error)) throw error;
      await this.close(server);
      return operation(await this.#connect(server));
    }
  }

  #touch(connection: LiveConnection): void {
    connection.lastUsed = Date.now();
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => { void this.close(connection.declaration.name); }, connection.declaration.idleTimeoutMs);
    connection.idleTimer.unref();
  }

  #setStatus(declaration: McpServerDeclaration, status: McpServerStatus["status"], detail?: string): void {
    const prior = this.#statuses.get(declaration.name);
    this.#statuses.set(declaration.name, {
      name: declaration.name,
      transport: declaration.transport,
      status,
      ...statusOrigin(declaration),
      ...(detail === undefined ? {} : { detail }),
      candidateCount: prior?.candidateCount ?? 0,
      bindingCount: prior?.bindingCount ?? 0,
    });
  }
}

function statusOrigin(declaration: McpServerDeclaration): Pick<McpServerStatus, "scope" | "marketplace"> {
  return {
    scope: declaration.scope,
    ...(declaration.marketplace === undefined ? {} : { marketplace: declaration.marketplace }),
  };
}

export class McpBindingDriftError extends Error {
  constructor(server: string, kind: string, name: string) { super(`MCP binding drifted: ${server}/${kind}/${name}`); this.name = "McpBindingDriftError"; }
}
export class McpRemoteToolError extends Error {
  readonly result: unknown;
  constructor(server: string, tool: string, result: unknown) { super(`MCP tool ${server}/${tool} returned isError`); this.name = "McpRemoteToolError"; this.result = result; }
}
export class McpSchemaError extends Error {
  constructor(server: string, tool: string, phase: "input" | "output") { super(`MCP tool ${server}/${tool} failed ${phase} schema validation`); this.name = "McpSchemaError"; }
}

async function resolveReferenceMap(map: Readonly<Record<string, string>>, credentials?: McpCredentialResolver): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    const match = /^\$\{(credential|env):([^}]+)\}$/.exec(value);
    if (!match) { result[key] = value; continue; }
    const resolved = match[1] === "env" ? process.env[match[2]!] : await credentials?.resolve(match[2]!);
    if (!resolved) throw new Error(`MCP reference is unavailable: ${value}`);
    result[key] = resolved;
  }
  return result;
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function pagedList<T extends Record<string, unknown>, K extends keyof T>(
  request: (cursor?: string) => Promise<T>,
  key: K,
): Promise<readonly unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1_000; page += 1) {
    let value: T;
    try { value = await request(cursor); }
    catch (error) { if (isUnsupportedMethod(error)) return []; throw error; }
    const chunk = value[key];
    if (!Array.isArray(chunk)) throw new TypeError(`MCP ${String(key)} response is not an array`);
    items.push(...chunk);
    const next = value.nextCursor;
    if (typeof next !== "string" || !next) return items;
    cursor = next;
  }
  throw new Error(`MCP ${String(key)} pagination exceeded 1000 pages`);
}
function isUnsupportedMethod(error: unknown): boolean {
  if (!isRecord(error)) return /method not found|not supported/i.test(errorMessage(error));
  return error.code === -32601 || /method not found|not supported/i.test(errorMessage(error));
}
function isRetryableConnectionError(error: unknown): boolean {
  return /connection|closed|socket|econnreset|eof|transport/i.test(errorMessage(error));
}
function candidateCount(snapshot: McpCandidateSnapshot | undefined): number { return snapshot ? snapshot.tools.length + snapshot.resources.length + snapshot.resourceTemplates.length + snapshot.prompts.length + (snapshot.instructions ? 1 : 0) : 0; }
function asRecord(value: unknown): Record<string, unknown> { return structuredClone(value) as Record<string, unknown>; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
