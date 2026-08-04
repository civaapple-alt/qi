import { randomBytes } from "node:crypto";
import type { SecureCredentialStore } from "@civaapple/qi-agent/capability";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { McpOAuthProviderFactory } from "./client-manager.js";
import type { McpServerDeclaration } from "./types.js";

interface PersistedOAuthState {
  version: 1;
  state?: string;
  verifier?: string;
  resourceUrl?: string;
  discovery?: OAuthDiscoveryState;
  clients: Record<string, StoredOAuthClientInformation>;
  tokens: Record<string, StoredOAuthTokens>;
  latestIssuer?: string;
}

export interface McpOAuthCallbacks {
  redirectToAuthorization(server: string, url: URL): void | Promise<void>;
  confirmAdditionalScopes?(server: string, addedScopes: readonly string[]): boolean | Promise<boolean>;
}

/**
 * SDK OAuth provider backed by Qi's encrypted credential store. The provider owns
 * PKCE/state/discovery/token persistence; only aliases and readiness reach config/logs.
 */
export class SealedMcpOAuthProvider implements OAuthClientProvider {
  readonly #store: SecureCredentialStore;
  readonly #server: McpServerDeclaration;
  readonly #callbacks: McpOAuthCallbacks;

  constructor(store: SecureCredentialStore, server: McpServerDeclaration, callbacks: McpOAuthCallbacks) {
    if (!server.oauth || !server.url) throw new TypeError(`MCP server ${server.name} is not configured for OAuth`);
    this.#store = store;
    this.#server = server;
    this.#callbacks = callbacks;
  }

  get redirectUrl(): URL { return new URL(this.#server.oauth!.redirectUrl); }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `Qi MCP (${this.#server.name})`,
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.#server.oauth!.scopes.length ? { scope: this.#server.oauth!.scopes.join(" ") } : {}),
    };
  }

  async state(): Promise<string> {
    const document = await this.#read();
    if (!document.state) {
      document.state = randomBytes(32).toString("base64url");
      await this.#write(document);
    }
    return document.state;
  }

  async validateCallbackState(received: string): Promise<void> {
    const document = await this.#read();
    if (!document.state || !constantTimeTextEqual(document.state, received)) throw new Error("MCP OAuth state mismatch");
    delete document.state;
    await this.#write(document);
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    return (await this.#read()).clients[issuerKey(ctx)];
  }

  async saveClientInformation(client: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    const document = await this.#read();
    document.clients[issuerKey(ctx)] = structuredClone(client);
    await this.#write(document);
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const document = await this.#read();
    const key = ctx ? issuerKey(ctx) : document.latestIssuer;
    return key ? document.tokens[key] : undefined;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const document = await this.#read();
    const key = issuerKey(ctx);
    const previous = document.tokens[key];
    const added = addedScopes(previous?.scope, tokens.scope);
    if (added.length && previous && !(await this.#callbacks.confirmAdditionalScopes?.(this.#server.name, added))) {
      throw new Error(`MCP OAuth scope step-up requires confirmation: ${added.join(", ")}`);
    }
    document.tokens[key] = structuredClone(tokens);
    document.latestIssuer = key;
    await this.#write(document);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.#callbacks.redirectToAuthorization(this.#server.name, new URL(url));
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (verifier.length < 43 || verifier.length > 128) throw new TypeError("Invalid PKCE verifier length");
    const document = await this.#read();
    document.verifier = verifier;
    await this.#write(document);
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.#read()).verifier;
    if (!verifier) throw new Error("MCP OAuth PKCE verifier is unavailable");
    return verifier;
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    const declared = new URL(this.#server.url!);
    const actualServer = new URL(serverUrl);
    if (actualServer.origin !== declared.origin) throw new Error("MCP OAuth resource server origin mismatch");
    if (!resource) return declared;
    const selected = new URL(resource);
    if (selected.origin !== declared.origin) throw new Error("MCP OAuth resource indicator origin mismatch");
    return selected;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") { await this.#store.delete(this.#accountId()); return; }
    const document = await this.#read();
    if (scope === "client") document.clients = {};
    else if (scope === "tokens") { document.tokens = {}; delete document.latestIssuer; }
    else if (scope === "verifier") delete document.verifier;
    else delete document.discovery;
    await this.#write(document);
  }

  async saveResourceUrl(resourceUrl: string): Promise<void> { const document = await this.#read(); document.resourceUrl = resourceUrl; await this.#write(document); }
  async resourceUrl(): Promise<string | undefined> { return (await this.#read()).resourceUrl; }
  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> { const document = await this.#read(); document.discovery = structuredClone(discovery); await this.#write(document); }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return (await this.#read()).discovery; }

  #accountId(): string { return `mcp-oauth:${this.#server.credentialAlias ?? this.#server.name}`; }
  async #read(): Promise<PersistedOAuthState> {
    const record = await this.#store.get(this.#accountId());
    if (!record) return { version: 1, clients: {}, tokens: {} };
    const parsed = JSON.parse(record.secret) as PersistedOAuthState;
    if (parsed.version !== 1 || !parsed.clients || !parsed.tokens) throw new TypeError(`Invalid sealed MCP OAuth state for ${this.#server.name}`);
    return parsed;
  }
  async #write(document: PersistedOAuthState): Promise<void> {
    await this.#store.set({ accountId: this.#accountId(), provider: "mcp", alias: this.#server.credentialAlias ?? this.#server.name, authKind: "oauth", secret: JSON.stringify(document), metadata: { server: this.#server.name, resource: new URL(this.#server.url!).origin } });
  }
}

export class SealedMcpOAuthProviderFactory implements McpOAuthProviderFactory {
  readonly #providers = new Map<string, SealedMcpOAuthProvider>();
  constructor(readonly store: SecureCredentialStore, readonly callbacks: McpOAuthCallbacks) {}
  async create(server: McpServerDeclaration): Promise<OAuthClientProvider | undefined> {
    if (!server.oauth) return undefined;
    let provider = this.#providers.get(server.name);
    if (!provider) { provider = new SealedMcpOAuthProvider(this.store, server, this.callbacks); this.#providers.set(server.name, provider); }
    return provider;
  }
  provider(server: string): SealedMcpOAuthProvider | undefined { return this.#providers.get(server); }
  async validateCallbackState(server: string, state: string): Promise<void> {
    const provider = this.#providers.get(server);
    if (!provider) throw new Error(`MCP OAuth provider is not active: ${server}`);
    await provider.validateCallbackState(state);
  }
  async invalidate(server: string): Promise<void> {
    const provider = this.#providers.get(server);
    if (provider) await provider.invalidateCredentials("all");
    this.#providers.delete(server);
  }
}

function issuerKey(ctx?: OAuthClientInformationContext): string { return ctx?.issuer ? new URL(ctx.issuer).origin : "default"; }
function scopeSet(value: string | undefined): Set<string> { return new Set((value ?? "").split(/\s+/).filter(Boolean)); }
function addedScopes(before: string | undefined, after: string | undefined): string[] { const prior = scopeSet(before); return [...scopeSet(after)].filter((scope) => !prior.has(scope)).sort(); }
function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right); if (a.length !== b.length) return false;
  let difference = 0; for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!; return difference === 0;
}
