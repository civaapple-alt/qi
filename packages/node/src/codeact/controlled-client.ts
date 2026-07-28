import type { EventStore } from "@civaapple/qi-agent/kernel";
import { EventWriter } from "@civaapple/qi-agent/loop";
import { createId, type RunId, type SessionId, type StepId } from "@civaapple/qi-protocol";
import {
  AuthorityDeniedError,
  EffectReplayBlockedError,
  ToolFailure,
  ToolInputError,
  ToolOutputError,
  type ArtifactStore,
  type ToolRegistry,
} from "@civaapple/qi-node/tools";
import type { EffectJournal } from "@civaapple/qi-node/workspace";

export type CodeActCallResult =
  | { ok: true; output: unknown; actionId: string; leaseId: string; replayed?: boolean }
  | { ok: false; code: string; message: string; actionId?: string; retryable: boolean };

export interface ControlledToolClientOptions {
  store: EventStore;
  registry: ToolRegistry;
  sessionId: SessionId;
  runId: RunId;
  stepId: StepId;
  subject: string;
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  effectJournal?: EffectJournal;
  idempotencyScope?: string;
  signal?: AbortSignal;
  clock?: () => Date;
  /**
   * When provided, only these Tool names may be called from this controlled client; every other name fails
   * closed as TOOL_NOT_ALLOWED before any inspection or Session event, independent of what the subject's
   * capability leases would otherwise authorize. Callers use this to block self-recursion or delegation
   * chaining regardless of granted leases.
   */
  allowedTools?: readonly string[];
}

export class ControlledToolClient {
  readonly #options: ControlledToolClientOptions;
  readonly #writer: EventWriter;

  constructor(options: ControlledToolClientOptions) {
    this.#options = options;
    this.#writer = new EventWriter(options.store, options.sessionId, options.clock);
  }

  async call(name: string, input: unknown): Promise<CodeActCallResult> {
    if (this.#options.allowedTools && !this.#options.allowedTools.includes(name)) {
      return {
        ok: false,
        code: "TOOL_NOT_ALLOWED",
        message: `Tool ${name} is not in this CodeAct program's allowed tool list`,
        retryable: false,
      };
    }
    const advertised = this.#options.registry.catalog().find((entry) => entry.name === name);
    if (!advertised) return { ok: false, code: "TOOL_NOT_FOUND", message: `Tool ${name} is not registered`, retryable: false };
    const actionId = createId("act");
    const context = {
      sessionId: this.#options.sessionId,
      runId: this.#options.runId,
      stepId: this.#options.stepId,
      actionId,
      subject: this.#options.subject,
      workspaceRoot: this.#options.workspaceRoot,
      artifactStore: this.#options.artifactStore,
      ...(this.#options.effectJournal === undefined ? {} : { effectJournal: this.#options.effectJournal }),
      ...(this.#options.idempotencyScope === undefined ? {} : { idempotencyScope: this.#options.idempotencyScope }),
      ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
    };
    let inspected;
    try {
      inspected = this.#options.registry.inspect(name, advertised.identity, input, context);
    } catch (error) {
      return failure(error, undefined);
    }
    const ref = { runId: this.#options.runId, stepId: this.#options.stepId, actionId };
    this.#writer.append("action.proposed", {
      ...ref,
      toolName: name,
      toolIdentity: inspected.identity,
      input: inspected.input,
      resources: [...inspected.resources],
      effect: inspected.effect,
    }, { kind: "agent", id: this.#options.subject });
    this.#writer.append("authority.requested", ref, { kind: "runtime", id: "capability-broker" });
    let authorized;
    try {
      authorized = await inspected.authorize();
    } catch (error) {
      if (error instanceof AuthorityDeniedError) {
        this.#writer.append("authority.denied", {
          ...ref,
          reason: error.message,
          policyTrace: error.policyTrace,
        }, { kind: "runtime", id: "capability-broker" });
      }
      return failure(error, actionId);
    }
    this.#writer.append("authority.granted", {
      ...ref,
      leaseId: authorized.leaseId,
      policyTrace: [...authorized.policyTrace],
    }, { kind: "runtime", id: "capability-broker" });
    this.#writer.append("action.started", ref, { kind: "runtime", id: "tool-runtime" });
    try {
      const settlement = await authorized.execute();
      this.#writer.append("action.completed", {
        ...ref,
        modelOutput: settlement.modelOutput,
      }, { kind: "runtime", id: "tool-runtime" });
      return {
        ok: true,
        output: settlement.output,
        actionId,
        leaseId: settlement.leaseId,
        ...(settlement.replayed === undefined ? {} : { replayed: settlement.replayed }),
      };
    } catch (error) {
      if (error instanceof ToolFailure || error instanceof ToolInputError || error instanceof ToolOutputError || error instanceof EffectReplayBlockedError) {
        const code = error instanceof ToolFailure ? error.code : error.name;
        this.#writer.append("action.failed", { ...ref, errorCode: code }, { kind: "runtime", id: "tool-runtime" });
      } else if (this.#options.signal?.aborted) {
        this.#writer.append("action.cancelled", { ...ref, reason: message(error) }, { kind: "runtime", id: "tool-runtime" });
      } else {
        this.#writer.append("action.indeterminate", {
          ...ref,
          reason: message(error),
          reconciliationHint: `Inspect the effect journal for ${actionId} before retrying`,
        }, { kind: "runtime", id: "tool-runtime" });
      }
      return failure(error, actionId);
    }
  }
}

function failure(error: unknown, actionId: string | undefined): CodeActCallResult {
  const code = error instanceof ToolFailure ? error.code : error instanceof Error ? error.name : "UNKNOWN_ERROR";
  return {
    ok: false,
    code,
    message: message(error),
    ...(actionId === undefined ? {} : { actionId }),
    retryable: false,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
