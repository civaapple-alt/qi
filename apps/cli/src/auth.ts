import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  EncryptedFileCredentialStore,
  InMemoryCredentialBroker,
  type SecureCredentialStore,
} from "@civaapple/qi-capability";
import {
  classifyProfileEndpoint,
  createModelPortForProfile,
  listProviderProfiles,
  requireProviderProfile,
  type ModelPort,
} from "@civaapple/qi-llm";
import {
  createFetchKimiOAuthTransport,
  KIMI_CODING_API_BASE,
  parseKimiSecret,
  pollKimiDeviceToken,
  refreshKimiAccessToken,
  requestKimiDeviceAuthorization,
  serializeKimiSecret,
  type KimiOAuthTransport,
} from "./kimi-oauth.js";
import {
  normalizeAccountAlias,
  validateProviderBaseURL,
  type ProviderConfig,
} from "./provider.js";

export interface AuthSessionStatus {
  readonly provider: string;
  readonly accountAlias: string;
  readonly authStatus: "ready" | "missing" | "expired";
  readonly authKind?: "api-key" | "oauth";
  readonly wireApi: string;
  readonly endpointTrust: "official" | "custom";
  readonly model: string;
  readonly baseURL?: string;
}

export class AuthSession {
  readonly #store: SecureCredentialStore;
  readonly #broker = new InMemoryCredentialBroker();
  readonly #subject: string;
  #config: ProviderConfig;
  #modelPort: ModelPort | undefined;
  #credentialId: string | undefined;
  #handle: string | undefined;

  private constructor(
    store: SecureCredentialStore,
    config: ProviderConfig,
    subject: string,
  ) {
    this.#store = store;
    this.#config = config;
    this.#subject = subject;
  }

  static async create(options: {
    config: ProviderConfig;
    qiHome?: string;
    store?: SecureCredentialStore;
    subject?: string;
  }): Promise<AuthSession> {
    const qiHome = options.qiHome ?? defaultQiHome();
    const store = options.store ?? new EncryptedFileCredentialStore(qiHome);
    const session = new AuthSession(store, options.config, options.subject ?? "main-agent");
    await session.hydrate();
    return session;
  }

  get config(): ProviderConfig {
    return this.#config;
  }

  status(): AuthSessionStatus {
    return {
      provider: this.#config.provider,
      accountAlias: this.#config.accountAlias,
      authStatus: this.#modelPort ? "ready" : this.#config.authStatus === "ready" ? "ready" : "missing",
      wireApi: this.#config.wireApi,
      endpointTrust: this.#config.endpointTrust,
      model: this.#config.model,
      ...(this.#config.baseURL === undefined ? {} : { baseURL: this.#config.baseURL }),
    };
  }

  requireModelPort(): ModelPort {
    if (!this.#modelPort) {
      throw new TypeError(
        `Provider ${this.#config.provider} is not authenticated. Run /login ${this.#config.provider}`,
      );
    }
    return this.#modelPort;
  }

  async hydrate(): Promise<AuthSessionStatus> {
    const accountId = accountKey(this.#config.provider, this.#config.accountAlias);
    const stored = await this.#store.get(accountId);
    if (stored) {
      let secret = stored.secret;
      if (stored.authKind === "oauth") {
        secret = await this.#maybeRefreshOAuth(stored.provider, secret, accountId);
      }
      this.#installSecret(secret, stored.authKind, stored.expiresAt);
      return this.status();
    }
    if (this.#config.apiKey) {
      this.#installSecret(this.#config.apiKey, "api-key");
    } else {
      this.#modelPort = undefined;
      this.#config = { ...this.#config, authStatus: "missing" };
    }
    return this.status();
  }

  async loginApiKey(
    provider: string,
    apiKey: string,
    aliasOrOptions: string | { alias?: string; model?: string; baseURL?: string } = "default",
  ): Promise<AuthSessionStatus> {
    const options = typeof aliasOrOptions === "string"
      ? { alias: aliasOrOptions }
      : aliasOrOptions;
    const alias = normalizeAccountAlias(options.alias);
    const requestedModel = optionalNonEmpty(options.model);
    const profile = requireProviderProfile(provider);
    if (!profile.authSchemes.includes("api-key")) {
      throw new TypeError(`${profile.displayName} does not support API-key login`);
    }
    const switching = this.#config.provider !== provider;
    const model = requestedModel
      ?? (switching ? profile.defaultModel : undefined)
      ?? this.#config.model
      ?? profile.defaultModel;
    if (!model) {
      throw new TypeError(
        `${profile.displayName} requires a model; pass model in the login form, config.toml, QI_MODEL, or --model`,
      );
    }
    const requestedBase = optionalNonEmpty(options.baseURL);
    const baseURL = validateProviderBaseURL(
      requestedBase
        ?? (switching ? profile.officialBaseURL : undefined)
        ?? this.#config.baseURL
        ?? profile.officialBaseURL,
      `${profile.displayName} base URL`,
    );
    const endpointTrust = classifyProfileEndpoint(profile, baseURL);
    const accountId = accountKey(provider, alias);
    await this.#store.set({
      accountId,
      provider,
      alias,
      authKind: "api-key",
      secret: apiKey,
      metadata: { baseURL, model },
    });
    this.#config = withoutApiKey({
      ...this.#config,
      provider,
      profile,
      accountAlias: alias,
      wireApi: profile.wireApi,
      model,
      baseURL,
      endpointTrust,
      authStatus: "ready",
    });
    this.#installSecret(apiKey, "api-key");
    return this.status();
  }

  /**
   * Activate a previously sealed account. For `compatible`, routing comes from
   * `routing` (config catalog) or credential metadata.
   */
  async useAccount(
    provider: string,
    alias: string,
    routing?: { model?: string; baseURL?: string },
  ): Promise<AuthSessionStatus> {
    const normalizedAlias = normalizeAccountAlias(alias);
    const profile = requireProviderProfile(provider);
    const accountId = accountKey(provider, normalizedAlias);
    const stored = await this.#store.get(accountId);
    if (!stored) {
      throw new TypeError(
        `No sealed credential for ${provider}:${normalizedAlias}. Run /login ${provider} first.`,
      );
    }
    const model = optionalNonEmpty(routing?.model)
      ?? optionalNonEmpty(stored.metadata?.model)
      ?? (provider === this.#config.provider && this.#config.accountAlias === normalizedAlias
        ? this.#config.model
        : undefined)
      ?? profile.defaultModel;
    if (!model) {
      throw new TypeError(
        provider === "compatible"
          ? `${profile.displayName} requires a model; set it in config.toml [[compatible]] or re-login`
          : `${profile.displayName} requires a model; re-login with a model or set QI_MODEL / config.toml model`,
      );
    }
    const baseURL = validateProviderBaseURL(
      optionalNonEmpty(routing?.baseURL)
        ?? optionalNonEmpty(stored.metadata?.baseURL)
        ?? (provider === this.#config.provider && this.#config.accountAlias === normalizedAlias
          ? this.#config.baseURL
          : undefined)
        ?? profile.officialBaseURL,
      `${profile.displayName} base URL`,
    );
    let secret = stored.secret;
    if (stored.authKind === "oauth") {
      secret = await this.#maybeRefreshOAuth(stored.provider, secret, accountId);
    }
    const metadataModel = optionalNonEmpty(stored.metadata?.model);
    const metadataBase = optionalNonEmpty(stored.metadata?.baseURL);
    if (metadataModel !== model || metadataBase !== baseURL) {
      await this.#store.set({
        ...stored,
        secret,
        metadata: {
          ...stored.metadata,
          model,
          baseURL,
        },
      });
    }
    this.#config = withoutApiKey({
      ...this.#config,
      provider,
      profile,
      accountAlias: normalizedAlias,
      wireApi: profile.wireApi,
      model,
      baseURL,
      endpointTrust: classifyProfileEndpoint(profile, baseURL),
      authStatus: "ready",
    });
    this.#installSecret(secret, stored.authKind, stored.expiresAt);
    return this.status();
  }

  async loginKimiDevice(options: {
    alias?: string;
    model?: string;
    transport?: KimiOAuthTransport;
    signal?: AbortSignal;
    onAuthorization?: (info: {
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
    }) => void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {}): Promise<AuthSessionStatus> {
    const alias = options.alias ?? "default";
    const transport = options.transport ?? createFetchKimiOAuthTransport();
    const authorization = await requestKimiDeviceAuthorization(transport);
    options.onAuthorization?.({
      userCode: authorization.userCode,
      verificationUri: authorization.verificationUri,
      verificationUriComplete: authorization.verificationUriComplete,
    });
    const pollOptions: {
      signal?: AbortSignal;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {};
    if (options.signal) pollOptions.signal = options.signal;
    if (options.sleep) pollOptions.sleep = options.sleep;
    const tokens = await pollKimiDeviceToken(transport, authorization, pollOptions);
    const accountId = accountKey("kimi", alias);
    const secret = serializeKimiSecret(tokens);
    const profile = requireProviderProfile("kimi");
    const requestedModel = optionalNonEmpty(options.model);
    const model = requestedModel
      ?? (this.#config.provider === "kimi" ? this.#config.model : undefined)
      ?? profile.defaultModel
      ?? "kimi-for-coding";
    await this.#store.set({
      accountId,
      provider: "kimi",
      alias,
      authKind: "oauth",
      secret,
      expiresAt: tokens.expiresAt,
      metadata: { authHost: "auth.kimi.com", model, baseURL: KIMI_CODING_API_BASE },
    });
    this.#config = {
      provider: "kimi",
      profile,
      accountAlias: alias,
      wireApi: profile.wireApi,
      model,
      baseURL: KIMI_CODING_API_BASE,
      endpointTrust: "official",
      authStatus: "ready",
    };
    this.#installSecret(tokens.accessToken, "oauth", tokens.expiresAt);
    return this.status();
  }

  async logout(provider = this.#config.provider, alias = this.#config.accountAlias): Promise<boolean> {
    const removed = await this.#store.delete(accountKey(provider, alias));
    if (this.#credentialId) this.#broker.revokeCredential(this.#credentialId);
    this.#credentialId = undefined;
    this.#handle = undefined;
    this.#modelPort = undefined;
    if (provider === this.#config.provider && alias === this.#config.accountAlias) {
      this.#config = withoutApiKey({ ...this.#config, authStatus: "missing" });
    }
    return removed;
  }

  listAccounts(): Promise<readonly {
    accountId: string;
    provider: string;
    alias: string;
    authKind: string;
    model?: string;
    baseURL?: string;
  }[]> {
    return this.#store.list().then((records) =>
      records.map((record) => ({
        accountId: record.accountId,
        provider: record.provider,
        alias: record.alias,
        authKind: record.authKind,
        ...(record.metadata?.model === undefined ? {} : { model: record.metadata.model }),
        ...(record.metadata?.baseURL === undefined ? {} : { baseURL: record.metadata.baseURL }),
      })),
    );
  }

  async #maybeRefreshOAuth(provider: string, secret: string, accountId: string): Promise<string> {
    if (provider !== "kimi") return parseKimiSecret(secret).accessToken;
    const tokens = parseKimiSecret(secret);
    const expiresAt = Date.parse(tokens.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 5 * 60_000) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) return tokens.accessToken;
    const refreshed = await refreshKimiAccessToken(createFetchKimiOAuthTransport(), tokens.refreshToken);
    const serialized = serializeKimiSecret(refreshed);
    const existing = await this.#store.get(accountId);
    if (existing) {
      await this.#store.set({ ...existing, secret: serialized, expiresAt: refreshed.expiresAt });
    }
    return refreshed.accessToken;
  }

  #installSecret(secret: string, authKind: "api-key" | "oauth", expiresAt?: string): void {
    if (this.#credentialId) this.#broker.revokeCredential(this.#credentialId);
    const credentialId = `provider:${this.#config.provider}:${this.#config.accountAlias}`;
    const origin = this.#config.baseURL ?? this.#config.profile.officialBaseURL;
    this.#broker.register(credentialId, secret, {
      tools: ["model.stream"],
      resources: [`provider:${this.#config.provider}`, `origin:${origin}`],
      expiresAt: expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
      audience: this.#config.provider,
      origin,
    });
    const issued = this.#broker.issue(credentialId, this.#subject);
    this.#credentialId = credentialId;
    this.#handle = issued.handle;
    const accessToken = authKind === "oauth" ? safeAccessToken(secret) : secret;
    this.#modelPort = createModelPortForProfile(this.#config.profile, {
      apiKey: accessToken,
      ...(this.#config.baseURL === undefined ? {} : { baseURL: this.#config.baseURL }),
      contextTokens: this.#config.profile.contextTokens,
    });
    this.#config = withoutApiKey({ ...this.#config, authStatus: "ready" });
  }
}

function withoutApiKey(
  config: Omit<ProviderConfig, "apiKey"> & { readonly apiKey?: string },
): ProviderConfig {
  const { apiKey: _apiKey, ...rest } = config;
  return rest;
}

export function parseLoginCommand(argument: string): {
  provider: string;
  mode: "device" | "api-key" | "status" | "logout" | "list" | "use";
  apiKey?: string;
  alias?: string;
  model?: string;
  baseURL?: string;
} {
  const trimmed = argument.trim();
  if (!trimmed || trimmed === "status") return { provider: "", mode: "status" };
  if (trimmed === "list") return { provider: "", mode: "list" };
  const useMatch = /^use(?:\s+(\S+))?$/i.exec(trimmed);
  if (useMatch) {
    const token = useMatch[1];
    if (!token) {
      throw new TypeError(
        "Usage: /login use <provider|compatible-name>  (switch to a sealed account)",
      );
    }
    return resolveUseLoginTarget(token);
  }
  const logout = /^logout(?:\s+(\S+))?(?:\s+(\S+))?$/i.exec(trimmed);
  if (logout) {
    return {
      provider: logout[1] ?? "",
      mode: "logout",
      ...(logout[2] ? { alias: logout[2] } : {}),
    };
  }
  const parts = trimmed.split(/\s+/);
  const provider = parts[0]?.toLowerCase() ?? "";
  if (!getKnownProvider(provider)) {
    throw new TypeError(
      `Unknown provider ${provider}. Known: ${listProviderProfiles().map((profile) => profile.id).join(", ")}`,
    );
  }
  if (parts[1] === undefined || parts[1] === "device" || parts[1] === "oauth") {
    const optionParts = parts[1] === undefined ? [] : parts.slice(2);
    const extracted = extractLoginKeyOptions(optionParts);
    if (extracted.rest.length > 0) {
      throw new TypeError(`Usage: /login ${provider} [device] [model <id>]`);
    }
    return {
      provider,
      mode: "device",
      ...(extracted.model === undefined ? {} : { model: extracted.model }),
      ...(extracted.alias === undefined ? {} : { alias: extracted.alias }),
    };
  }
  if (parts[1] === "key" || parts[1] === "api-key") {
    const extracted = extractLoginKeyOptions(parts.slice(2));
    const apiKey = extracted.rest.join(" ").trim();
    if (!apiKey) {
      throw new TypeError(
        `Usage: /login ${provider} key <api-key> [name <id>] [model <id>] [base_url <url>]`,
      );
    }
    return {
      provider,
      mode: "api-key",
      apiKey,
      ...(extracted.alias === undefined ? {} : { alias: extracted.alias }),
      ...(extracted.model === undefined ? {} : { model: extracted.model }),
      ...(extracted.baseURL === undefined ? {} : { baseURL: extracted.baseURL }),
    };
  }
  // `/login kimi model <id>` implies device/OAuth login with an explicit model.
  const bareOptions = extractLoginKeyOptions(parts.slice(1));
  if (bareOptions.rest.length === 0 && (bareOptions.model !== undefined || bareOptions.alias !== undefined)) {
    return {
      provider,
      mode: "device",
      ...(bareOptions.model === undefined ? {} : { model: bareOptions.model }),
      ...(bareOptions.alias === undefined ? {} : { alias: bareOptions.alias }),
    };
  }
  throw new TypeError(
    `Usage: /login ${provider} [device [model <id>]|key <api-key> [name <id>] [model <id>] [base_url <url>]] or /login use <provider|name>`,
  );
}

function extractLoginKeyOptions(parts: readonly string[]): {
  readonly rest: string[];
  readonly alias?: string;
  readonly model?: string;
  readonly baseURL?: string;
} {
  let rest = [...parts];
  let alias: string | undefined;
  let model: string | undefined;
  let baseURL: string | undefined;
  while (rest.length >= 2) {
    const flag = rest.at(-2)?.toLowerCase();
    const value = rest.at(-1);
    if (!value) break;
    if (flag === "model") {
      model = value;
      rest = rest.slice(0, -2);
      continue;
    }
    if (flag === "base_url" || flag === "base-url") {
      baseURL = value;
      rest = rest.slice(0, -2);
      continue;
    }
    if (flag === "name" || flag === "alias") {
      alias = value;
      rest = rest.slice(0, -2);
      continue;
    }
    break;
  }
  return {
    rest,
    ...(alias === undefined ? {} : { alias }),
    ...(model === undefined ? {} : { model }),
    ...(baseURL === undefined ? {} : { baseURL }),
  };
}

function getKnownProvider(id: string): boolean {
  try {
    requireProviderProfile(id);
    return true;
  } catch {
    return false;
  }
}

/** `/login use deepseek` or `/login use qianwenai` (compatible alias). */
export function resolveUseLoginTarget(token: string): {
  provider: string;
  mode: "use";
  alias: string;
} {
  const id = token.trim().toLowerCase();
  if (!id) {
    throw new TypeError("Usage: /login use <provider|compatible-name>");
  }
  if (getKnownProvider(id)) {
    return { provider: id, mode: "use", alias: "default" };
  }
  return { provider: "compatible", mode: "use", alias: normalizeAccountAlias(id) };
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function accountKey(provider: string, alias: string): string {
  return `${provider}:${alias}`;
}

function defaultQiHome(): string {
  return process.env.QI_HOME?.trim()
    ? resolve(process.env.QI_HOME)
    : resolve(homedir(), ".qi");
}

function safeAccessToken(secret: string): string {
  try {
    return parseKimiSecret(secret).accessToken;
  } catch {
    return secret;
  }
}
