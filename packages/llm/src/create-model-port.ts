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
  const contextTokens = options.contextTokens ?? profile.contextTokens;
  if (profile.wireApi === "responses") {
    const portOptions: OpenAIResponsesModelPortOptions = {
      providerNames: [profile.id],
      contextTokens,
      requestMetadata: profile.capabilities.requestMetadata,
    };
    return OpenAIResponsesModelPort.fromClientOptions(clientOptions, portOptions);
  }
  const portOptions: OpenAIChatCompletionsModelPortOptions = {
    providerNames: [profile.id],
    contextTokens,
    profile,
  };
  return OpenAIChatCompletionsModelPort.fromClientOptions(clientOptions, portOptions);
}
