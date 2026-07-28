import { randomUUID } from "node:crypto";
import type { ActionIntent } from "./broker.js";

interface CredentialRecord {
  secret: string;
  tools: readonly string[];
  resources: readonly string[];
  expiresAt: string;
  audience?: string;
  origin?: string;
}

export interface CredentialHandle {
  readonly handle: string;
  readonly credentialId: string;
}

export interface CredentialRegistration {
  tools: readonly string[];
  resources: readonly string[];
  expiresAt: string;
  audience?: string;
  origin?: string;
}

export interface CredentialBroker {
  register(credentialId: string, secret: string, policy: CredentialRegistration): void;
  issue(credentialId: string, subject: string): CredentialHandle;
  resolve(handle: string, intent: ActionIntent, now?: Date): string;
  withCredential<T>(
    handle: string,
    intent: ActionIntent,
    callback: (secret: string) => Promise<T> | T,
    now?: Date,
  ): Promise<T>;
  revokeCredential(credentialId: string): boolean;
}

/** Keeps secrets behind opaque handles; only the execution side can resolve them. */
export class InMemoryCredentialBroker implements CredentialBroker {
  readonly #credentials = new Map<string, CredentialRecord>();
  readonly #handles = new Map<string, { credentialId: string; subject: string }>();

  register(credentialId: string, secret: string, policy: CredentialRegistration): void {
    if (!credentialId || !secret) throw new TypeError("Credential ID and secret are required");
    if (!Number.isFinite(Date.parse(policy.expiresAt))) throw new TypeError("Credential expiry must be valid");
    this.#credentials.set(credentialId, {
      secret,
      tools: policy.tools,
      resources: policy.resources,
      expiresAt: policy.expiresAt,
      ...(policy.audience === undefined ? {} : { audience: policy.audience }),
      ...(policy.origin === undefined ? {} : { origin: policy.origin }),
    });
  }

  issue(credentialId: string, subject: string): CredentialHandle {
    if (!this.#credentials.has(credentialId)) throw new Error(`Credential ${credentialId} does not exist`);
    const handle = `cred_${randomUUID()}`;
    this.#handles.set(handle, { credentialId, subject });
    return { handle, credentialId };
  }

  resolve(handle: string, intent: ActionIntent, now = new Date()): string {
    const binding = this.#handles.get(handle);
    if (!binding) throw new Error("Credential handle is unknown or revoked");
    if (binding.subject !== intent.subject) throw new Error("Credential handle belongs to another subject");
    const credential = this.#credentials.get(binding.credentialId);
    if (!credential) throw new Error("Credential was revoked");
    if (Date.parse(credential.expiresAt) <= now.getTime()) throw new Error("Credential has expired");
    if (!credential.tools.includes(intent.tool)) throw new Error(`Credential does not permit ${intent.tool}`);
    if (!intent.resources.every((resource) => credential.resources.includes(resource))) {
      throw new Error("Credential does not permit the target resource");
    }
    return credential.secret;
  }

  async withCredential<T>(
    handle: string,
    intent: ActionIntent,
    callback: (secret: string) => Promise<T> | T,
    now = new Date(),
  ): Promise<T> {
    const secret = this.resolve(handle, intent, now);
    return callback(secret);
  }

  revokeCredential(credentialId: string): boolean {
    const removed = this.#credentials.delete(credentialId);
    for (const [handle, binding] of this.#handles) {
      if (binding.credentialId === credentialId) this.#handles.delete(handle);
    }
    return removed;
  }
}
