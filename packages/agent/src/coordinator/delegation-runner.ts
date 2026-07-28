import type { ModelPort, ModelRef } from "@civaapple/qi-ai";
import { TurnLoop, type TurnResult } from "@civaapple/qi-agent/loop";
import type { ArtifactStore, ToolRegistry } from "@civaapple/qi-agent/tools";
import type {
  Coordinator,
  DelegationAuthorization,
  DelegationContract,
  DelegationHandle,
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
  settlement: { accepted: boolean; reasons: string[] };
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
  const wallTimeMs = contract.resourceEnvelope.wallTimeMs;
  const timeout = AbortSignal.timeout(wallTimeMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const contextBlocks = [
    {
      id: "delegation-constitution",
      kind: "constitution" as const,
      source: "qi:coordinator",
      role: "system" as const,
      content:
        "You are an isolated Qi Subagent. Work only from the allowlisted context and tools. " +
        "Do not claim parent Session authority. Return a concise factual answer; the parent will verify.",
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
    const timedOut = timeout.aborted && !options.signal?.aborted;
    const cancelled = Boolean(options.signal?.aborted);
    const reasons = [error instanceof Error ? error.message : String(error)];
    const settlement = options.coordinator.return(handle, {
      outcome: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
      evidence: [],
      reasons,
    });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      delegation: { handle, settlement },
    });
  }

  const summaryText = turn.text.trim().slice(0, 2_000) || "(empty child response)";
  const result = { summary: summaryText, status: turn.status };
  const resultStored = await options.artifactStore.put(
    Buffer.from(JSON.stringify(result), "utf8"),
    "application/json",
  );
  const summaryStored = await options.artifactStore.put(
    Buffer.from(summaryText, "utf8"),
    "text/plain; charset=utf-8",
  );

  const forcedOutcome =
    turn.status === "completed" ? undefined
      : turn.status === "cancelled" ? "cancelled" as const
        : turn.status === "parked" ? "failed" as const
          : "failed" as const;

  const settlement = options.coordinator.return(handle, {
    result,
    resultRef: resultStored.ref,
    summaryRef: summaryStored.ref,
    evidence: [],
    ...(forcedOutcome === undefined ? {} : { outcome: forcedOutcome, reasons: [`Child Run ended as ${turn.status}`] }),
  });

  return {
    handle,
    turn,
    settlement,
    resultRef: resultStored.ref,
    summaryRef: summaryStored.ref,
  };
}
