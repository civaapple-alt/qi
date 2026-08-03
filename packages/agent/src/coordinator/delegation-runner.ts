import type { ModelPort, ModelRef } from "@civaapple/qi-ai";
import { TurnLoop, type TurnResult } from "@civaapple/qi-agent/loop";
import type { ArtifactStore, ToolRegistry } from "@civaapple/qi-agent/tools";
import type {
  Coordinator,
  DelegationAuthorization,
  DelegationContract,
  DelegationHandle,
  DelegationSubmission,
} from "./coordinator.js";
import { contextBlocksFromRefs } from "./context-refs.js";

export interface DelegationRunnerOptions {
  coordinator: Coordinator;
  turnLoop: TurnLoop;
  model: ModelRef;
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  /** Shared registry; child Turns advertise only contract.childLease.tools. */
  toolRegistry: ToolRegistry;
  modelPort?: ModelPort;
  signal?: AbortSignal;
}

export interface DelegationRunResult {
  handle: DelegationHandle;
  turn: TurnResult;
  settlement: {
    accepted: boolean;
    outcome: NonNullable<DelegationSubmission["outcome"]>;
    reasons: string[];
  };
  resultRef?: string;
  summaryRef?: string;
}

/**
 * Execute a depth-1 Subagent: durable delegate → isolated TurnLoop → evidence-gated return.
 * Parent model context receives only returned Artifact refs and a short summary, never the child transcript.
 */
export async function runDelegatedTurn(
  contract: DelegationContract,
  authorization: DelegationAuthorization,
  options: DelegationRunnerOptions & { input: string },
): Promise<DelegationRunResult> {
  const handle = await options.coordinator.delegate(contract, authorization);
  return executeDelegatedHandle(handle, contract, options);
}

export const DELEGATED_BATCH_MAX = 4;
/** Short preview stored in summaryRef / returned inline to the parent model. */
export const DELEGATED_SUMMARY_PREVIEW_CHARS = 2_000;
/** Full child deliverable stored in resultRef (hard cap). */
export const DELEGATED_RESULT_MAX_CHARS = 200_000;

export interface DelegatedBatchItem {
  contract: DelegationContract;
  input: string;
}

/**
 * Fan out 1–4 depth-1 Subagents: create all durable handles first (so the parent projection shows every
 * Running row), then run child Turns concurrently. Parent abort cancels the shared signal.
 */
export async function runDelegatedBatch(
  items: readonly DelegatedBatchItem[],
  authorization: DelegationAuthorization,
  options: DelegationRunnerOptions,
): Promise<DelegationRunResult[]> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new RangeError("runDelegatedBatch requires at least one item");
  }
  if (items.length > DELEGATED_BATCH_MAX) {
    throw new RangeError(`runDelegatedBatch supports at most ${DELEGATED_BATCH_MAX} items`);
  }
  const prepared: { handle: DelegationHandle; contract: DelegationContract; input: string }[] = [];
  for (const item of items) {
    const handle = await options.coordinator.delegate(item.contract, authorization);
    prepared.push({ handle, contract: item.contract, input: item.input });
  }
  return Promise.all(
    prepared.map(({ handle, contract, input }) =>
      executeDelegatedHandle(handle, contract, { ...options, input }),
    ),
  );
}

async function executeDelegatedHandle(
  handle: DelegationHandle,
  contract: DelegationContract,
  options: DelegationRunnerOptions & { input: string },
): Promise<DelegationRunResult> {
  const wallTimeMs = contract.resourceEnvelope.wallTimeMs;
  // AbortSignal.timeout() uses an unref'ed timer. That lets Node exit while a child model
  // stream is still awaiting the abort, which leaves the test runner (and callers) with an
  // unsettled Promise on Node 22. Keep this timer referenced until the child settles.
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), wallTimeMs);
  const timeout = timeoutController.signal;
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const contextBlocks = [
    {
      id: "delegation-constitution",
      kind: "constitution" as const,
      source: "qi:coordinator",
      role: "system" as const,
      content:
        "You are an isolated Qi Subagent. Follow the user brief's Focus / Return / Constraints sections. " +
        "Work only from the allowlisted context and tools. Do not claim parent Session authority. " +
        "Return a concise structured answer that covers every Return item; the parent will verify and synthesize.",
      priority: 100,
      required: true,
      retentionReason: "Isolated Subagent constitution",
    },
    ...(await contextBlocksFromRefs(options.artifactStore, contract.contextRefs)),
  ];

  let turn: TurnResult;
  try {
    turn = await options.turnLoop.run({
      sessionId: handle.childSessionId,
      title: `Subagent: ${contract.outcome.slice(0, 80)}`,
      subject: handle.childSubject,
      input: options.input,
      model: options.model,
      contextBlocks,
      contextBudgetTokens: Math.max(1, Math.floor(contract.resourceEnvelope.contextTokens)),
      maxSteps: Math.max(1, Math.floor(contract.resourceEnvelope.maxSteps)),
      ...(contract.resourceEnvelope.maxActionsPerStep === undefined
        ? {}
        : { maxActionsPerStep: Math.max(1, Math.floor(contract.resourceEnvelope.maxActionsPerStep)) }),
      toolAllowlist: [...contract.childLease.tools],
      workspaceRoot: options.workspaceRoot,
      artifactStore: options.artifactStore,
      signal,
    });
  } catch (error) {
    clearTimeout(timeoutTimer);
    const { outcome, reasons } = classifyAbort(timeout, options.signal, wallTimeMs, error);
    const settlement = options.coordinator.return(handle, {
      outcome,
      evidence: [],
      reasons,
    });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      delegation: { handle, settlement },
    });
  }

  const fullText = turn.text.trim() || "(empty child response)";
  const resultTruncated = fullText.length > DELEGATED_RESULT_MAX_CHARS;
  const storedText = resultTruncated ? fullText.slice(0, DELEGATED_RESULT_MAX_CHARS) : fullText;
  const summaryText = fullText.slice(0, DELEGATED_SUMMARY_PREVIEW_CHARS);
  // Settlement schema stays { summary, status }; artifact JSON may note hard-cap truncation.
  const result = { summary: storedText, status: turn.status };
  const resultStored = await options.artifactStore.put(
    Buffer.from(JSON.stringify({
      ...result,
      ...(resultTruncated
        ? { truncated: true, originalChars: fullText.length }
        : {}),
    }), "utf8"),
    "application/json",
  );
  const summaryStored = await options.artifactStore.put(
    Buffer.from(summaryText, "utf8"),
    "text/plain; charset=utf-8",
  );

  // TurnLoop maps every AbortSignal abort to run/action cancelled. Wall-time expiry must surface as
  // timed_out so parents do not treat resource limits like a user interrupt.
  const wallTimedOut = timeout.aborted && !options.signal?.aborted;
  const forcedOutcome =
    turn.status === "completed" ? undefined
      : wallTimedOut ? "timed_out" as const
        : turn.status === "cancelled" ? "cancelled" as const
          : turn.status === "parked" ? "failed" as const
            : "failed" as const;

  const settlement = options.coordinator.return(handle, {
    result,
    resultRef: resultStored.ref,
    summaryRef: summaryStored.ref,
    evidence: [],
    ...(forcedOutcome === undefined
      ? {}
      : {
          outcome: forcedOutcome,
          reasons: wallTimedOut
            ? [
                `Child wallTimeMs ${wallTimeMs} elapsed`,
                `Child Run ended as ${turn.status}`,
                "Integrate any partial summary/refs below; do not treat this as a user cancel.",
              ]
            : [`Child Run ended as ${turn.status}`],
        }),
  });

  clearTimeout(timeoutTimer);

  return {
    handle,
    turn,
    settlement: {
      accepted: settlement.accepted,
      outcome: settlement.outcome,
      reasons: settlement.reasons,
    },
    resultRef: resultStored.ref,
    summaryRef: summaryStored.ref,
  };
}

function classifyAbort(
  timeout: AbortSignal,
  parentSignal: AbortSignal | undefined,
  wallTimeMs: number,
  error: unknown,
): { outcome: "timed_out" | "cancelled" | "failed"; reasons: string[] } {
  const detail = error instanceof Error ? error.message : String(error);
  if (timeout.aborted && !parentSignal?.aborted) {
    return {
      outcome: "timed_out",
      reasons: [
        `Child wallTimeMs ${wallTimeMs} elapsed`,
        detail,
        "Integrate any partial summary/refs; do not treat this as a user cancel.",
      ],
    };
  }
  if (parentSignal?.aborted) {
    return { outcome: "cancelled", reasons: [detail] };
  }
  return { outcome: "failed", reasons: [detail] };
}
