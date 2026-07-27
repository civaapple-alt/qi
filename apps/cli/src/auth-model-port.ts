import type { ModelCapabilities, ModelPort, ModelRef, ModelRequest, ModelEvent } from "@civaapple/qi-llm";
import { modelCapabilitiesFromProfile } from "@civaapple/qi-llm";
import type { AuthSession } from "./auth.js";

/** ModelPort that resolves credentials through AuthSession only at call time. */
export class AuthBackedModelPort implements ModelPort {
  readonly #auth: AuthSession;

  constructor(auth: AuthSession) {
    this.#auth = auth;
  }

  async capabilities(model: ModelRef): Promise<ModelCapabilities> {
    try {
      return this.#auth.requireModelPort().capabilities(model);
    } catch {
      const profile = this.#auth.config.profile;
      return modelCapabilitiesFromProfile(profile, {
        contextTokens: profile.contextTokens,
      });
    }
  }

  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    return this.#auth.requireModelPort().stream(request, signal);
  }
}
