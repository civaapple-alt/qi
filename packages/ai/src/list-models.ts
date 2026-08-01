import {
  getProviderModelProfile,
  type ProviderModelProfile,
  type ProviderProfile,
} from "./provider-profile.js";

/** Subset of OpenAI-compatible / Kimi `GET /v1/models` fields used for discovery. */
export interface RemoteModelInfo {
  readonly id: string;
  readonly contextLength?: number;
  readonly supportsImageIn?: boolean;
  readonly supportsVideoIn?: boolean;
  readonly supportsReasoning?: boolean;
  readonly ownedBy?: string;
}

export interface MergedProviderModel {
  readonly id: string;
  readonly displayName: string;
  readonly contextTokens: number;
  /** True when the id appears in the static provider catalog (thinking/effort authority). */
  readonly catalogued: boolean;
  readonly profile?: ProviderModelProfile;
  readonly remote?: RemoteModelInfo;
}

export interface ListOpenAICompatibleModelsOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

/**
 * List models from an OpenAI-compatible `GET {baseURL}/models` endpoint.
 * Used for discovery only; thinking/wire authority remains on the static catalog (ADR-0009).
 */
export async function listOpenAICompatibleModels(
  baseURL: string,
  apiKey: string,
  options: ListOpenAICompatibleModelsOptions = {},
): Promise<readonly RemoteModelInfo[]> {
  const root = baseURL.replace(/\/+$/, "");
  const url = `${root}/models`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("listOpenAICompatibleModels requires fetch");
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new TypeError(
      `GET ${url} failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  const payload = (await response.json()) as { data?: unknown };
  if (!Array.isArray(payload.data)) {
    throw new TypeError(`GET ${url} returned an unexpected payload (missing data array)`);
  }
  const models: RemoteModelInfo[] = [];
  for (const item of payload.data) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.trim() === "") continue;
    models.push({
      id: row.id,
      ...(typeof row.context_length === "number" && Number.isFinite(row.context_length)
        ? { contextLength: Math.trunc(row.context_length) }
        : {}),
      ...(typeof row.supports_image_in === "boolean" ? { supportsImageIn: row.supports_image_in } : {}),
      ...(typeof row.supports_video_in === "boolean" ? { supportsVideoIn: row.supports_video_in } : {}),
      ...(typeof row.supports_reasoning === "boolean"
        ? { supportsReasoning: row.supports_reasoning }
        : {}),
      ...(typeof row.owned_by === "string" ? { ownedBy: row.owned_by } : {}),
    });
  }
  return models;
}

/**
 * Merge a static provider catalog with a remote `/models` list.
 * Catalog entries win for displayName and thinking; remote-only ids are appended for selection.
 */
export function mergeProviderModels(
  profile: ProviderProfile,
  remote: readonly RemoteModelInfo[] | undefined,
): readonly MergedProviderModel[] {
  const remoteById = new Map((remote ?? []).map((model) => [model.id, model]));
  const seen = new Set<string>();
  const merged: MergedProviderModel[] = [];

  for (const catalog of profile.models ?? []) {
    seen.add(catalog.id);
    const remoteModel = remoteById.get(catalog.id);
    merged.push({
      id: catalog.id,
      displayName: catalog.displayName,
      contextTokens: remoteModel?.contextLength ?? catalog.contextTokens,
      catalogued: true,
      profile: catalog,
      ...(remoteModel === undefined ? {} : { remote: remoteModel }),
    });
  }

  for (const remoteModel of remote ?? []) {
    if (seen.has(remoteModel.id)) continue;
    seen.add(remoteModel.id);
    const catalog = getProviderModelProfile(profile, remoteModel.id);
    merged.push({
      id: remoteModel.id,
      displayName: catalog?.displayName ?? remoteModel.id,
      contextTokens: remoteModel.contextLength
        ?? catalog?.contextTokens
        ?? profile.contextTokens,
      catalogued: catalog !== undefined,
      ...(catalog === undefined ? {} : { profile: catalog }),
      remote: remoteModel,
    });
  }

  return merged;
}
