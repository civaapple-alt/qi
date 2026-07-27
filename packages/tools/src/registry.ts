import {
  redactSensitiveValue,
  type CapabilityBroker,
  type Effect,
  type RedactionSummary,
} from "@civaapple/qi-capability";
import type { ModelContentPart, PortableTool } from "@civaapple/qi-llm";
import { effectIdempotencyKey, effectIntentHash, type EffectJournal } from "@civaapple/qi-workspace";
import { type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AuthorityDeniedError,
  EffectReplayBlockedError,
  StaleToolError,
  ToolFailure,
  ToolInputError,
  ToolOutputError,
} from "./errors.js";
import type { WorkspaceMount } from "./workspace.js";

export interface ArtifactStore {
  put(content: Uint8Array, mediaType: string): Promise<{ ref: string; size: number; sha256: string }>;
  get(ref: string): Promise<{ content: Uint8Array; mediaType: string }>;
}

export interface ToolExecutionContext {
  sessionId: string;
  runId: string;
  stepId: string;
  actionId: string;
  subject: string;
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  /** Frozen Run mode for capability narrowing; never widens leases. */
  mode?: "ask" | "plan" | "agent";
  /** Read-only mounts available to discovery tools; prefer getMounts for mid-Run grants. */
  mounts?: readonly WorkspaceMount[];
  /** Live mount snapshot so a mid-Run human grant applies to the next Action. */
  getMounts?: () => readonly WorkspaceMount[];
  signal?: AbortSignal;
  effectJournal?: EffectJournal;
  idempotencyScope?: string;
  reportActivity?: (activity: ToolExecutionActivity) => void;
}

export interface ToolExecutionActivity {
  readonly type: "output";
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly truncated: boolean;
}

export interface ToolDefinition<Input extends TSchema, Output extends TSchema> {
  description: string;
  input: Input;
  output: Output;
  effect(input: Static<Input>): Effect;
  resources(input: Static<Input>, context: ToolExecutionContext): readonly string[];
  execute(input: Static<Input>, context: ToolExecutionContext): Promise<Static<Output>>;
  toModelOutput?(output: Static<Output>): ModelContentPart[];
}

export type AnyToolDefinition = ToolDefinition<TSchema, TSchema>;

export function defineTool<Input extends TSchema, Output extends TSchema>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

interface Registration {
  identity: string;
  definition: AnyToolDefinition;
}

export interface RegisteredTool {
  name: string;
  identity: string;
  model: PortableTool;
}

export interface ToolSettlement {
  name: string;
  identity: string;
  leaseId: string;
  output: unknown;
  modelOutput: ModelContentPart[];
  redactions?: readonly RedactionSummary[];
  idempotencyKey?: string;
  replayed?: boolean;
}

export interface InspectedToolCall {
  name: string;
  identity: string;
  effect: Effect;
  resources: readonly string[];
  input: unknown;
  authorize(): Promise<AuthorizedToolCall>;
}

export interface AuthorizedToolCall {
  name: string;
  identity: string;
  effect: Effect;
  resources: readonly string[];
  leaseId: string;
  policyTrace: readonly { leaseId: string; matched: boolean; reason: string }[];
  execute(): Promise<ToolSettlement>;
}

export interface RegistrationHandle {
  identity: string;
  close(): void;
}

export class ToolRegistry {
  readonly #capability: CapabilityBroker;
  readonly #registrations = new Map<string, Registration[]>();
  #nextIdentity = 1;

  constructor(capability: CapabilityBroker) {
    this.#capability = capability;
  }

  register<Input extends TSchema, Output extends TSchema>(
    name: string,
    definition: ToolDefinition<Input, Output>,
  ): RegistrationHandle {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) throw new TypeError(`Invalid tool name: ${name}`);
    if (!definition.description) throw new TypeError(`Tool ${name} requires a description`);

    const identity = `${name}@${this.#nextIdentity++}`;
    const registration: Registration = { identity, definition: definition as AnyToolDefinition };
    const stack = this.#registrations.get(name) ?? [];
    stack.push(registration);
    this.#registrations.set(name, stack);
    let closed = false;

    return {
      identity,
      close: () => {
        if (closed) return;
        const current = this.#registrations.get(name);
        if (current) {
          const index = current.indexOf(registration);
          if (index >= 0) current.splice(index, 1);
          if (current.length === 0) this.#registrations.delete(name);
        }
        closed = true;
      },
    };
  }

  catalog(options?: { tools?: readonly string[] }): RegisteredTool[] {
    const allowlist = options?.tools === undefined ? undefined : new Set(options.tools);
    return [...this.#registrations.entries()]
      .map(([name, stack]) => {
        if (allowlist && !allowlist.has(name)) return undefined;
        const current = stack.at(-1);
        if (!current) return undefined;
        return {
          name,
          identity: current.identity,
          model: {
            name,
            description: current.definition.description,
            inputSchema: structuredClone(current.definition.input) as Record<string, unknown>,
          },
        };
      })
      .filter((tool): tool is RegisteredTool => tool !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async execute(
    name: string,
    advertisedIdentity: string,
    rawInput: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolSettlement> {
    const inspected = this.inspect(name, advertisedIdentity, rawInput, context);
    const authorized = await inspected.authorize();
    return authorized.execute();
  }

  inspect(
    name: string,
    advertisedIdentity: string,
    rawInput: unknown,
    context: ToolExecutionContext,
  ): InspectedToolCall {
    const current = this.#registrations.get(name)?.at(-1);
    if (!current || current.identity !== advertisedIdentity) {
      throw new StaleToolError(name, advertisedIdentity, current?.identity);
    }

    if (!Value.Check(current.definition.input, rawInput)) {
      throw new ToolInputError(formatErrors(current.definition.input, rawInput));
    }
    const input = structuredClone(rawInput);
    const effect = current.definition.effect(input);
    const resources = current.definition.resources(input, context);
    let authorization: Promise<AuthorizedToolCall> | undefined;
    const inspected: InspectedToolCall = {
      name,
      identity: current.identity,
      effect,
      resources: [...resources],
      input: structuredClone(input),
      authorize: () => {
        authorization ??= this.#authorizeCaptured(
          name,
          current,
          input,
          effect,
          resources,
          context,
        );
        return authorization;
      },
    };
    return inspected;
  }

  async #authorizeCaptured(
    name: string,
    registration: Registration,
    input: unknown,
    effect: Effect,
    resources: readonly string[],
    context: ToolExecutionContext,
  ): Promise<AuthorizedToolCall> {
    const decision = await this.#capability.authorize({
      actionId: context.actionId,
      subject: context.subject,
      tool: name,
      effect,
      resources,
      sessionId: context.sessionId,
      runId: context.runId,
      ...(context.mode === undefined ? {} : { mode: context.mode }),
    });
    if (decision.outcome === "denied") throw new AuthorityDeniedError(decision.reason, decision.trace);
    const leaseId = decision.leaseId;
    let executed = false;

    return {
      name,
      identity: registration.identity,
      effect,
      resources: [...resources],
      leaseId,
      policyTrace: structuredClone(decision.trace),
      execute: async () => {
        if (executed) throw new Error(`Authorized tool call ${context.actionId} has already executed`);
        executed = true;
        if (context.signal?.aborted) {
          throw context.signal.reason ?? new DOMException("Tool call aborted", "AbortError");
        }

        const journal = effect === "read" ? undefined : context.effectJournal;
        const idempotencyKey = journal
          ? effectIdempotencyKey(context.idempotencyScope ?? context.runId, name, input, resources)
          : undefined;
        if (journal && idempotencyKey) {
          const intentHash = effectIntentHash({
            name,
            identity: registration.identity,
            input,
            effect,
            resources: [...resources].sort(),
          });
          const reservation = journal.begin({ idempotencyKey, intentHash, actionId: context.actionId });
          if (reservation.outcome === "blocked") {
            throw new EffectReplayBlockedError(idempotencyKey, reservation.reason);
          }
          if (reservation.outcome === "replay") return settlementFromOutput(reservation.output, true);
          journal.markStarted(idempotencyKey);
        }

        try {
          const executionContext: ToolExecutionContext = context.reportActivity === undefined
            ? context
            : {
                ...context,
                reportActivity: (activity) => {
                  const sanitized = redactSensitiveValue(activity);
                  context.reportActivity?.(sanitized.value);
                },
              };
          const rawOutput = await registration.definition.execute(input, executionContext);
          if (!Value.Check(registration.definition.output, rawOutput)) {
            throw new ToolOutputError(formatErrors(registration.definition.output, rawOutput));
          }
          const sanitized = redactSensitiveValue(rawOutput);
          if (journal && idempotencyKey) journal.complete(idempotencyKey, sanitized.value);
          return settlementFromOutput(sanitized.value, false, sanitized.redactions);
        } catch (error) {
          if (journal && idempotencyKey) {
            try {
              if (error instanceof ToolFailure || context.signal?.aborted) {
                journal.fail(idempotencyKey, error instanceof Error ? error.message : String(error));
              } else {
                journal.indeterminate(idempotencyKey, error instanceof Error ? error.message : String(error));
              }
            } catch {
              // If journal settlement also fails, the Session layer parks the Action as indeterminate.
            }
          }
          throw error;
        }

        function settlementFromOutput(
          candidateOutput: unknown,
          replayed: boolean,
          priorRedactions: readonly RedactionSummary[] = [],
        ): ToolSettlement {
          const sanitized = redactSensitiveValue(candidateOutput);
          const output = sanitized.value;
          if (!Value.Check(registration.definition.output, output)) {
            throw new ToolOutputError(formatErrors(registration.definition.output, output));
          }
          const modelOutput = registration.definition.toModelOutput?.(output) ?? [
            { type: "text", text: JSON.stringify(output) },
          ];
          const sanitizedModelOutput = redactSensitiveValue(modelOutput);
          const redactions = mergeRedactions(priorRedactions, sanitized.redactions, sanitizedModelOutput.redactions);
          return {
            name,
            identity: registration.identity,
            leaseId,
            output: structuredClone(output),
            modelOutput: structuredClone(sanitizedModelOutput.value),
            ...(redactions.length === 0 ? {} : { redactions }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey, replayed }),
          };
        }
      },
    };
  }
}

function mergeRedactions(...groups: readonly (readonly RedactionSummary[])[]): readonly RedactionSummary[] {
  const counts = new Map<RedactionSummary["kind"], number>();
  for (const group of groups) {
    for (const entry of group) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + entry.count);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }));
}

function formatErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 8)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
}
