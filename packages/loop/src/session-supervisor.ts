import type { EventStore, SessionView } from "@civaapple/qi-kernel";
import type { RunView } from "@civaapple/qi-kernel";
import type { SessionEvent, SessionId } from "@civaapple/qi-protocol";
import { EventWriter } from "./event-writer.js";

export interface RecoveryResult {
  recovered: boolean;
  view: SessionView | undefined;
  reason?: "indeterminate-effect" | "review";
  /** Clean Plan-accept / next-run trigger awaiting a single launch after restart. */
  resumableRunId?: string;
  pendingReview: boolean;
  pendingQuestion: boolean;
}

/** Serializes mutations per Session and turns abandoned active Runs into durable parked state. */
export class SessionSupervisor {
  readonly #store: EventStore;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;
  readonly #tails = new Map<SessionId, Promise<void>>();

  constructor(
    store: EventStore,
    options: { clock?: () => Date; onEvent?: (event: SessionEvent) => void } = {},
  ) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
  }

  async exclusive<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
    }
  }

  recover(sessionId: SessionId): RecoveryResult {
    const initial = this.#store.load(sessionId);
    const pendingReview = initial?.pendingReview?.status === "pending";
    const pendingQuestion = initial?.pendingQuestion?.status === "pending";
    const run = currentRecoverableRun(initial);
    if (!initial || !run) {
      return {
        recovered: false,
        view: initial,
        pendingReview,
        pendingQuestion,
      };
    }

    // Plan accept / next-run may leave a clean triggered Run with no Steps yet.
    // Leave it durable for a single resume launch; do not park or invent settlement.
    if (isCleanTriggeredRun(run)) {
      return {
        recovered: false,
        view: initial,
        resumableRunId: run.runId,
        pendingReview,
        pendingQuestion,
      };
    }

    const writer = new EventWriter(this.#store, sessionId, this.#clock, this.#onEvent);
    let indeterminate = false;
    for (const actionId of Object.keys(run.actions)) {
      const action = run.actions[actionId];
      if (!action) continue;
      switch (action.status) {
        case "proposed":
          writer.append(
            "authority.requested",
            { runId: run.runId, stepId: action.stepId, actionId: action.actionId },
            { kind: "runtime", id: "session_supervisor" },
          );
          writer.append(
            "authority.denied",
            {
              runId: run.runId,
              stepId: action.stepId,
              actionId: action.actionId,
              reason: "Process restarted before authorization",
            },
            { kind: "runtime", id: "session_supervisor" },
          );
          break;
        case "awaiting-authority":
          writer.append(
            "authority.denied",
            {
              runId: run.runId,
              stepId: action.stepId,
              actionId: action.actionId,
              reason: "Process restarted while authorization was pending",
            },
            { kind: "runtime", id: "session_supervisor" },
          );
          break;
        case "granted":
          writer.append(
            "action.cancelled",
            {
              runId: run.runId,
              stepId: action.stepId,
              actionId: action.actionId,
              reason: "Process restarted before executor entry",
            },
            { kind: "runtime", id: "session_supervisor" },
          );
          break;
        case "running":
          indeterminate = true;
          writer.append(
            "action.indeterminate",
            {
              runId: run.runId,
              stepId: action.stepId,
              actionId: action.actionId,
              reason: "Process restarted after executor entry but before settlement",
              reconciliationHint: "Inspect the Workspace and Effect Journal before retrying",
            },
            { kind: "runtime", id: "session_supervisor" },
          );
          break;
        default:
          break;
      }
    }

    for (const stepId of run.stepOrder) {
      const step = run.steps[stepId];
      if (step?.status !== "running") continue;
      writer.append(
        "step.completed",
        { runId: run.runId, stepId, finishReason: "error" },
        { kind: "runtime", id: "session_supervisor" },
      );
    }

    for (const delegation of Object.values(run.delegations)) {
      if (delegation.status !== "running") continue;
      writer.append(
        "delegation.returned",
        {
          runId: run.runId,
          delegationId: delegation.delegationId,
          childSessionId: delegation.childSessionId,
          outcome: "cancelled",
          evidenceRefs: [],
          coordinationWallTimeMs: 0,
          reasons: ["Process restarted while delegation was unsettled"],
        },
        { kind: "runtime", id: "session_supervisor" },
      );
    }

    const reason = indeterminate ? "indeterminate-effect" : "review";
    writer.append(
      "run.parked",
      {
        runId: run.runId,
        reason,
        detail: indeterminate
          ? "Recovery found an Action whose external effect cannot be confirmed"
          : "Recovery paused the abandoned Run at a durable boundary",
      },
      { kind: "runtime", id: "session_supervisor" },
    );
    const view = writer.view;
    return {
      recovered: true,
      view,
      reason,
      pendingReview: view?.pendingReview?.status === "pending",
      pendingQuestion: view?.pendingQuestion?.status === "pending",
    };
  }
}

function currentRecoverableRun(view: SessionView | undefined): RunView | undefined {
  if (!view?.currentRunId) return undefined;
  const run = view.runs[view.currentRunId];
  return run?.status === "active" || run?.status === "triggered" ? run : undefined;
}

function isCleanTriggeredRun(run: RunView): boolean {
  return (
    run.status === "triggered" &&
    run.stepOrder.length === 0 &&
    Object.keys(run.actions).length === 0 &&
    Object.keys(run.delegations).length === 0
  );
}
