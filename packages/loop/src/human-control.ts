import type { EventStore, PlanItemView, SessionMode, SessionView } from "@civaapple/qi-kernel";
import {
  createId,
  type PlanId,
  type PlanItemId,
  type QuestionId,
  type RunId,
  type SessionEvent,
  type SessionId,
} from "@civaapple/qi-protocol";
import { EventWriter, type EventActor, type EventBatchEntry } from "./event-writer.js";

export interface PlanRevisionInput {
  planId: PlanId;
  title: string;
  overview: string;
  artifactRef: string;
  sha256: string;
  path: string;
  items: readonly PlanItemView[];
  sourceRunId?: RunId;
}

export interface HumanControlServiceOptions {
  eventStore: EventStore;
  clock?: () => Date;
  onEvent?: (event: SessionEvent) => void;
}

/** Durable mode switches, Plan review settlement, and next-Run Questions (atomic batches). */
export class HumanControlService {
  readonly #store: EventStore;
  readonly #clock: () => Date;
  readonly #onEvent: ((event: SessionEvent) => void) | undefined;

  constructor(options: HumanControlServiceOptions) {
    this.#store = options.eventStore;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
  }

  ensureSession(sessionId: SessionId, title?: string, mode: SessionMode = "agent"): SessionView {
    const writer = this.#writer(sessionId);
    if (writer.view) return writer.view;
    writer.append(
      "session.created",
      { ...(title === undefined ? {} : { title }), mode },
      { kind: "runtime", id: "qi" },
    );
    const view = writer.view;
    if (!view) throw new Error("Session creation failed");
    return view;
  }

  changeMode(
    sessionId: SessionId,
    to: SessionMode,
    reason: string,
    actor: EventActor = { kind: "user", id: "user" },
  ): SessionView {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    if (view.mode === to) return view;
    writer.append(
      "session.mode.changed",
      { from: view.mode, to, reason },
      actor,
    );
    return requireView(writer.view);
  }

  addMount(
    sessionId: SessionId,
    mount: {
      mountId: string;
      path: string;
      mode: "read";
      source: "project_config" | "cli" | "grant" | "command";
    },
    actor: EventActor = { kind: "user", id: "user" },
  ): SessionView {
    const writer = this.#writer(sessionId);
    requireView(writer.view);
    if (writer.view?.mounts[mount.mountId]) return requireView(writer.view);
    writer.append(
      "workspace.mount.added",
      {
        mountId: mount.mountId,
        path: mount.path,
        mode: mount.mode,
        source: mount.source,
      },
      actor,
    );
    return requireView(writer.view);
  }

  removeMount(
    sessionId: SessionId,
    mountId: string,
    reason: string,
    actor: EventActor = { kind: "user", id: "user" },
  ): SessionView {
    const writer = this.#writer(sessionId);
    requireView(writer.view);
    if (!writer.view?.mounts[mountId]) return requireView(writer.view);
    writer.append("workspace.mount.removed", { mountId, reason }, actor);
    return requireView(writer.view);
  }

  recordPlanRevision(
    sessionId: SessionId,
    input: PlanRevisionInput,
    actor: EventActor = { kind: "agent", id: "plan_document" },
  ): SessionView {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    const plan = view.plans[input.planId];
    const revision = (plan?.latestRevision ?? 0) + 1;
    writer.appendBatch([
      {
        type: "plan.revision.recorded",
        data: {
          planId: input.planId,
          revision,
          title: input.title,
          overview: input.overview,
          artifactRef: input.artifactRef,
          sha256: input.sha256,
          path: input.path,
          items: input.items.map((item) => ({
            planItemId: item.planItemId,
            title: item.title,
            description: item.description,
            ...(item.verification === undefined ? {} : { verification: item.verification }),
            ...(item.dependsOn.length === 0 ? {} : { dependsOn: [...item.dependsOn] }),
          })),
          ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
        },
        actor,
      },
      {
        type: "plan.review.requested",
        data: { planId: input.planId, revision },
        actor: { kind: "runtime", id: "human_control" },
      },
    ]);
    return requireView(writer.view);
  }

  /** Accept Plan review, switch to Agent, and trigger exactly one Run for the first incomplete item. */
  acceptPlanAndStartFirstRun(
    sessionId: SessionId,
    actor: EventActor = { kind: "user", id: "user" },
  ): { view: SessionView; runId: RunId; planItemId: PlanItemId; input: string } {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    const pending = view.pendingReview;
    if (!pending || pending.status !== "pending") {
      throw new Error("No pending Plan review to accept");
    }
    const plan = view.plans[pending.planId];
    const revision = plan?.revisions[pending.revision];
    if (!plan || !revision) throw new Error("Pending Plan revision is missing");
    const first = firstIncompleteItem(view, pending.planId, pending.revision);
    if (!first) throw new Error("Plan has no incomplete items to execute");
    const runId = createId("run") as RunId;
    const input = formatPlanItemInput(revision.title, first);
    writer.appendBatch([
      {
        type: "plan.review.settled",
        data: {
          planId: pending.planId,
          revision: pending.revision,
          decision: "accepted",
        },
        actor,
      },
      {
        type: "session.mode.changed",
        data: { from: view.mode, to: "agent", reason: "Plan review accepted" },
        actor,
      },
      {
        type: "run.triggered",
        data: {
          runId,
          trigger: "user",
          input,
          mode: "agent",
          planBinding: {
            planId: pending.planId,
            revision: pending.revision,
            planItemId: first.planItemId,
          },
        },
        actor,
      },
    ]);
    return {
      view: requireView(writer.view),
      runId,
      planItemId: first.planItemId,
      input,
    };
  }

  settlePlanReview(
    sessionId: SessionId,
    decision: "rejected" | "revise",
    feedback?: string,
    actor: EventActor = { kind: "user", id: "user" },
  ): SessionView {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    const pending = view.pendingReview;
    if (!pending || pending.status !== "pending") {
      throw new Error("No pending Plan review to settle");
    }
    writer.append(
      "plan.review.settled",
      {
        planId: pending.planId,
        revision: pending.revision,
        decision,
        ...(feedback === undefined ? {} : { feedback }),
      },
      actor,
    );
    return requireView(writer.view);
  }

  askNextRunQuestion(sessionId: SessionId, completedRunId: RunId): SessionView | undefined {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    if (view.pendingQuestion?.status === "pending") return view;
    if (view.pendingReview?.status === "pending") return view;
    const run = view.runs[completedRunId];
    if (!run?.planBinding || !run.terminal) return undefined;
    const next = firstIncompleteItem(view, run.planBinding.planId, run.planBinding.revision);
    if (!next) return undefined;
    const questionId = createId("qst") as QuestionId;
    writer.append(
      "control.question.asked",
      {
        questionId,
        kind: "next_run",
        prompt: `Start the next Plan item: ${next.title}?`,
        choices: [
          { id: "continue", label: "Continue next item" },
          { id: "stop", label: "Stop" },
          { id: "return_to_plan", label: "Return to Plan" },
        ],
        planId: run.planBinding.planId,
        revision: run.planBinding.revision,
        completedRunId,
        nextPlanItemId: next.planItemId,
      },
      { kind: "runtime", id: "human_control" },
    );
    return requireView(writer.view);
  }

  /**
   * Re-ask a next-Run Question after `stop` (or any settled Question) when an accepted
   * Plan still has incomplete items. No-op when a Question/review is already pending.
   */
  reaskNextRunQuestion(sessionId: SessionId): SessionView | undefined {
    const view = this.#store.load(sessionId);
    if (!view) return undefined;
    if (view.pendingQuestion?.status === "pending") return view;
    if (view.pendingReview?.status === "pending") return undefined;
    const planId = view.currentPlanId;
    if (!planId) return undefined;
    const plan = view.plans[planId];
    const revision = plan?.acceptedRevision;
    if (revision === undefined) return undefined;
    if (!firstIncompleteItem(view, planId, revision)) return undefined;
    const completedRunId = latestTerminalPlanBoundRun(view, planId, revision);
    if (!completedRunId) return undefined;
    return this.askNextRunQuestion(sessionId, completedRunId);
  }

  answerNextRunQuestion(
    sessionId: SessionId,
    choiceId: "continue" | "stop" | "return_to_plan",
    actor: EventActor = { kind: "user", id: "user" },
  ): { view: SessionView; runId?: RunId; input?: string } {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    const pending = view.pendingQuestion;
    if (!pending || pending.status !== "pending" || pending.kind !== "next_run") {
      throw new Error("No pending next-run Question");
    }
    if (choiceId === "stop") {
      writer.append(
        "control.question.answered",
        { questionId: pending.questionId, choiceId },
        actor,
      );
      return { view: requireView(writer.view) };
    }
    if (choiceId === "return_to_plan") {
      const batch: EventBatchEntry[] = [
        {
          type: "control.question.answered",
          data: { questionId: pending.questionId, choiceId },
          actor,
        },
      ];
      if (view.mode !== "plan") {
        batch.push({
          type: "session.mode.changed",
          data: { from: view.mode, to: "plan", reason: "Returned to Plan after next-run Question" },
          actor,
        });
      }
      writer.appendBatch(batch);
      return { view: requireView(writer.view) };
    }

    if (!pending.planId || pending.revision === undefined || !pending.nextPlanItemId || !pending.completedRunId) {
      throw new Error("next_run Question is missing Plan binding fields");
    }
    const plan = view.plans[pending.planId];
    const revision = plan?.revisions[pending.revision];
    const item = revision?.items.find((candidate) => candidate.planItemId === pending.nextPlanItemId);
    if (!revision || !item) throw new Error("Next Plan item is missing");
    const runId = createId("run") as RunId;
    const input = formatPlanItemInput(revision.title, item);
    writer.appendBatch([
      {
        type: "control.question.answered",
        data: { questionId: pending.questionId, choiceId },
        actor,
      },
      {
        type: "run.triggered",
        data: {
          runId,
          trigger: "user",
          input,
          mode: "agent",
          planBinding: {
            planId: pending.planId,
            revision: pending.revision,
            planItemId: item.planItemId,
            continuationOf: pending.completedRunId,
          },
        },
        actor,
      },
    ]);
    return { view: requireView(writer.view), runId, input };
  }

  cancelPendingQuestion(sessionId: SessionId, reason: string): SessionView | undefined {
    const writer = this.#writer(sessionId);
    const view = writer.view;
    if (!view?.pendingQuestion || view.pendingQuestion.status !== "pending") return view;
    writer.append(
      "control.question.cancelled",
      { questionId: view.pendingQuestion.questionId, reason },
      { kind: "runtime", id: "human_control" },
    );
    return writer.view;
  }

  #writer(sessionId: SessionId): EventWriter {
    return new EventWriter(this.#store, sessionId, this.#clock, this.#onEvent);
  }
}

export function firstIncompleteItem(
  view: SessionView,
  planId: PlanId,
  revision: number,
): PlanItemView | undefined {
  const plan = view.plans[planId];
  const rev = plan?.revisions[revision];
  if (!rev) return undefined;
  for (const item of rev.items) {
    const bound = view.runOrder.some((runId) => {
      const run = view.runs[runId];
      return (
        run?.planBinding?.planId === planId &&
        run.planBinding.revision === revision &&
        run.planBinding.planItemId === item.planItemId &&
        (run.status === "triggered" ||
          run.status === "active" ||
          run.status === "completed" ||
          run.status === "parked")
      );
    });
    if (!bound) return item;
  }
  return undefined;
}

/** Most recent terminal Plan-bound Run for re-asking a next-Run Question after stop. */
export function latestTerminalPlanBoundRun(
  view: SessionView,
  planId: PlanId,
  revision: number,
): RunId | undefined {
  for (let index = view.runOrder.length - 1; index >= 0; index -= 1) {
    const runId = view.runOrder[index];
    if (!runId) continue;
    const run = view.runs[runId];
    if (
      run?.planBinding?.planId === planId
      && run.planBinding.revision === revision
      && run.terminal
    ) {
      return runId;
    }
  }
  return undefined;
}

export function formatPlanItemInput(planTitle: string, item: PlanItemView): string {
  const lines = [
    `Execute Plan item from "${planTitle}":`,
    "",
    `## ${item.title}`,
    item.description,
  ];
  if (item.verification) {
    lines.push("", "### Verification", item.verification);
  }
  return lines.join("\n");
}

function requireView(view: SessionView | undefined): SessionView {
  if (!view) throw new Error("Session does not exist");
  return view;
}
