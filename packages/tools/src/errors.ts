export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class ToolOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolOutputError";
  }
}

export class EffectReplayBlockedError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, reason: string) {
    super(`Effect ${idempotencyKey} is blocked: ${reason}`);
    this.name = "EffectReplayBlockedError";
    this.idempotencyKey = idempotencyKey;
  }
}

export class ToolFailure extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.details = details;
  }
}

export class AuthorityDeniedError extends Error {
  readonly reason: string;
  readonly policyTrace: readonly { leaseId: string; matched: boolean; reason: string }[];

  constructor(reason: string, policyTrace: readonly { leaseId: string; matched: boolean; reason: string }[] = []) {
    super(reason);
    this.name = "AuthorityDeniedError";
    this.reason = reason;
    this.policyTrace = structuredClone(policyTrace);
  }
}

export class StaleToolError extends Error {
  constructor(name: string, advertisedIdentity: string, currentIdentity?: string) {
    super(
      `Tool ${name} was advertised as ${advertisedIdentity}, but the current identity is ${currentIdentity ?? "missing"}`,
    );
    this.name = "StaleToolError";
  }
}
