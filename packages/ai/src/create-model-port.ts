import {
  OpenAIChatCompletionsModelPort,
  type OpenAIChatCompletionsModelPortOptions,
} from "./openai-chat-completions.js";
import {
  OpenAIResponsesModelPort,
  type OpenAIResponsesModelPortOptions,
} from "./openai-responses.js";
import type { ModelPort } from "./model.js";
import {
  requireProviderProfile,
  type ProviderProfile,
} from "./provider-profile.js";
import { resolveModelCapabilities } from "./resolve-model-capabilities.js";
import type { ClientOptions } from "openai";

export interface CreateModelPortOptions {
  apiKey: string;
  baseURL?: string;
  /** Selected model id; used to resolve per-model wire API and context window. */
  model?: string;
  contextTokens?: number;
  reasoningEffort?: string | null;
  imageInput?: boolean;
  profile?: ProviderProfile;
}

/** Build the correct wire adapter for an explicit provider profile. */
export function createModelPortForProfile(
  profileOrId: ProviderProfile | string,
  options: CreateModelPortOptions,
): ModelPort {
  const profile = typeof profileOrId === "string" ? requireProviderProfile(profileOrId) : profileOrId;
  const model = options.model ?? profile.defaultModel ?? "";
  const resolved = resolveModelCapabilities(profile, model, {
    ...(options.contextTokens === undefined ? {} : { contextWindowTokens: options.contextTokens }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.imageInput === undefined ? {} : { imageInput: options.imageInput }),
  });
  const clientOptions: ClientOptions = {
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  };
  if (resolved.wireApi === "responses") {
    const portOptions: OpenAIResponsesModelPortOptions = {
      providerNames: [profile.id],
      contextTokens: resolved.contextTokens,
      requestMetadata: profile.capabilities.requestMetadata,
      imageInput: resolved.imageInput,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      profile,
    };
    return OpenAIResponsesModelPort.fromClientOptions(clientOptions, portOptions);
  }
  const portOptions: OpenAIChatCompletionsModelPortOptions = {
    providerNames: [profile.id],
    profile,
    contextTokens: resolved.contextTokens,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    imageInput: options.imageInput ?? resolved.imageInput,
  };
  return OpenAIChatCompletionsModelPort.fromClientOptions(clientOptions, portOptions);
}
