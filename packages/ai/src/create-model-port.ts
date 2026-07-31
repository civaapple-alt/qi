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
  providerModelContextTokens,
  requireProviderProfile,
  resolveProviderWireApi,
  type ProviderProfile,
} from "./provider-profile.js";
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
  const wireApi = resolveProviderWireApi(profile, model);
  const contextTokens = options.contextTokens ??
    (model ? providerModelContextTokens(profile, model) : profile.contextTokens);
  const clientOptions: ClientOptions = {
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  };
  if (wireApi === "responses") {
    const imageInput = options.imageInput ?? resolveResponsesImageInput(profile, model);
    const portOptions: OpenAIResponsesModelPortOptions = {
      providerNames: [profile.id],
      contextTokens,
      requestMetadata: profile.capabilities.requestMetadata,
      imageInput,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      profile,
    };
    return OpenAIResponsesModelPort.fromClientOptions(clientOptions, portOptions);
  }
  const portOptions: OpenAIChatCompletionsModelPortOptions = {
    providerNames: [profile.id],
    profile,
    contextTokens,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.imageInput === undefined ? {} : { imageInput: options.imageInput }),
  };
  return OpenAIChatCompletionsModelPort.fromClientOptions(clientOptions, portOptions);
}

function resolveResponsesImageInput(profile: ProviderProfile, model: string): boolean {
  // Responses adapters historically advertise images when the profile omits modalities (OpenAI/xAI).
  // Explicit text-only profiles (DeepSeek) disable image input.
  const modelModalities = profile.models?.find((item) => item.id === model)?.inputModalities;
  if (modelModalities) return modelModalities.includes("image");
  if (profile.inputModalities) return profile.inputModalities.includes("image");
  return true;
}
