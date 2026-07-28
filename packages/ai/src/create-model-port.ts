import {
  OpenAIChatCompletionsModelPort,
  type OpenAIChatCompletionsModelPortOptions,
} from "./openai-chat-completions.js";
import {
  OpenAIResponsesModelPort,
  type OpenAIResponsesModelPortOptions,
} from "./openai-responses.js";
import type { ModelPort } from "./model.js";
import { requireProviderProfile, type ProviderProfile } from "./provider-profile.js";
import type { ClientOptions } from "openai";

export interface CreateModelPortOptions {
  apiKey: string;
  baseURL?: string;
  contextTokens?: number;
  reasoningEffort?: string | null;
  profile?: ProviderProfile;
}

/** Build the correct wire adapter for an explicit provider profile. */
export function createModelPortForProfile(
  profileOrId: ProviderProfile | string,
  options: CreateModelPortOptions,
): ModelPort {
  const profile = typeof profileOrId === "string" ? requireProviderProfile(profileOrId) : profileOrId;
  const clientOptions: ClientOptions = {
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  };
  if (profile.wireApi === "responses") {
    const portOptions: OpenAIResponsesModelPortOptions = {
      providerNames: [profile.id],
      contextTokens: options.contextTokens ?? profile.contextTokens,
      requestMetadata: profile.capabilities.requestMetadata,
    };
    return OpenAIResponsesModelPort.fromClientOptions(clientOptions, portOptions);
  }
  const portOptions: OpenAIChatCompletionsModelPortOptions = {
    providerNames: [profile.id],
    profile,
    ...(options.contextTokens === undefined ? {} : { contextTokens: options.contextTokens }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  };
  return OpenAIChatCompletionsModelPort.fromClientOptions(clientOptions, portOptions);
}
