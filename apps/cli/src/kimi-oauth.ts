/**
 * Kimi Code OAuth device-code client (RFC 8628).
 * Uses Qi's own contract against auth.kimi.com — does not read kimi-code credential files.
 */

export const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_CODING_API_BASE = "https://api.kimi.com/coding/v1";

export interface KimiDeviceAuthorization {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface KimiOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: string;
  readonly tokenType: string;
  readonly scope?: string;
}

export interface KimiOAuthTransport {
  postForm(url: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }>;
}

export class KimiOAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KimiOAuthError";
    this.code = code;
  }
}

export function createFetchKimiOAuthTransport(fetchImpl: typeof fetch = fetch): KimiOAuthTransport {
  return {
    async postForm(url, body) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(body).toString(),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, json };
    },
  };
}

export async function requestKimiDeviceAuthorization(
  transport: KimiOAuthTransport,
  host = KIMI_OAUTH_HOST,
): Promise<KimiDeviceAuthorization> {
  const { status, json } = await transport.postForm(`${host.replace(/\/$/, "")}/api/oauth/device_authorization`, {
    client_id: KIMI_OAUTH_CLIENT_ID,
  });
  if (status !== 200) {
    throw new KimiOAuthError("device_authorization_failed", `Device authorization failed (${status})`);
  }
  return {
    userCode: String(json.user_code ?? ""),
    deviceCode: String(json.device_code ?? ""),
    verificationUri: String(json.verification_uri ?? "https://www.kimi.com/code/login"),
    verificationUriComplete: String(json.verification_uri_complete ?? json.verification_uri ?? ""),
    expiresIn: Number(json.expires_in) || 900,
    interval: Math.max(1, Number(json.interval) || 5),
  };
}

export async function pollKimiDeviceToken(
  transport: KimiOAuthTransport,
  authorization: KimiDeviceAuthorization,
  options: {
    host?: string;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => Date;
  } = {},
): Promise<KimiOAuthTokens> {
  const host = (options.host ?? KIMI_OAUTH_HOST).replace(/\/$/, "");
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const deadline = now().getTime() + authorization.expiresIn * 1_000;
  let intervalMs = authorization.interval * 1_000;

  while (now().getTime() < deadline) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Kimi login cancelled", "AbortError");
    }
    const { status, json } = await transport.postForm(`${host}/api/oauth/token`, {
      client_id: KIMI_OAUTH_CLIENT_ID,
      device_code: authorization.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (status === 200 && typeof json.access_token === "string") {
      const expiresIn = Number(json.expires_in) || 3_600;
      return {
        accessToken: json.access_token,
        ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
        expiresAt: new Date(now().getTime() + expiresIn * 1_000).toISOString(),
        tokenType: String(json.token_type ?? "Bearer"),
        ...(typeof json.scope === "string" ? { scope: json.scope } : {}),
      };
    }
    const error = String(json.error ?? "");
    if (error === "authorization_pending" || error === "slow_down") {
      if (error === "slow_down") intervalMs += 5_000;
      await sleep(intervalMs, options.signal);
      continue;
    }
    if (error === "expired_token" || error === "access_denied") {
      throw new KimiOAuthError(error, `Kimi login ${error.replaceAll("_", " ")}`);
    }
    throw new KimiOAuthError("token_failed", `Kimi token exchange failed (${status})`);
  }
  throw new KimiOAuthError("expired_token", "Kimi login timed out before authorization completed");
}

export async function refreshKimiAccessToken(
  transport: KimiOAuthTransport,
  refreshToken: string,
  options: { host?: string; now?: () => Date } = {},
): Promise<KimiOAuthTokens> {
  const host = (options.host ?? KIMI_OAUTH_HOST).replace(/\/$/, "");
  const now = options.now ?? (() => new Date());
  const { status, json } = await transport.postForm(`${host}/api/oauth/token`, {
    client_id: KIMI_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (status !== 200 || typeof json.access_token !== "string") {
    throw new KimiOAuthError("refresh_failed", `Kimi token refresh failed (${status})`);
  }
  const expiresIn = Number(json.expires_in) || 3_600;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : refreshToken,
    expiresAt: new Date(now().getTime() + expiresIn * 1_000).toISOString(),
    tokenType: String(json.token_type ?? "Bearer"),
    ...(typeof json.scope === "string" ? { scope: json.scope } : {}),
  };
}

export function serializeKimiSecret(tokens: KimiOAuthTokens): string {
  return JSON.stringify({
    access_token: tokens.accessToken,
    ...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
    expires_at: tokens.expiresAt,
    token_type: tokens.tokenType,
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  });
}

export function parseKimiSecret(secret: string): KimiOAuthTokens {
  const raw = JSON.parse(secret) as Record<string, unknown>;
  if (typeof raw.access_token !== "string") throw new TypeError("Kimi secret is missing access_token");
  return {
    accessToken: raw.access_token,
    ...(typeof raw.refresh_token === "string" ? { refreshToken: raw.refresh_token } : {}),
    expiresAt: typeof raw.expires_at === "string"
      ? raw.expires_at
      : new Date(Date.now() + 3_600_000).toISOString(),
    tokenType: String(raw.token_type ?? "Bearer"),
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Kimi login cancelled", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
