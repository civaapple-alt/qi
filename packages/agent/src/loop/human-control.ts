import type {
  EventStore,
  PlanItemView,
  PlanRevisionView,
  SessionMode,
  SessionView,
} from "@civaapple/qi-agent/kernel";
import {
  createId,
  type ActionId,
  type PlanId,
  type PlanItemId,
  type QuestionId,
  type RunId,
  type SessionEvent,
  type SessionId,
  type StepId,
  type WorkItemId,
  type WorkPlanId,
} from "@civaapple/qi-protocol";
import { EventWriter, type EventActor, type EventBatchEntry } from "./event-writer.js";

export interface PlanRevisionInput {
  planId: PlanId;
  /** Missing on historical callers and fixtures; defaults to legacy_items. */
  format?: "legacy_items" | "formal_markdown";
  title: string;
  overview: string;
  artifactRef: string;
  sha256: string;
  path: string;
  markdown?: string;
  items?: readonly PlanItemView[];
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

  view(sessionId: SessionId): SessionView | undefined {
    return this.#store.load(sessionId);
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

  grantSensitivePath(
    sessionId: SessionId,
    path: string,
    source: "project_config" | "grant" | "command" = "grant",
    actor: EventActor = { kind: "user", id: "user" },
  ): SessionView {
    const writer = this.#writer(sessionId);
    requireView(writer.view);
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    if (writer.view?.sensitivePathGrants[normalized]) return requireView(writer.view);
    writer.append(
      "workspace.sensitive_path.granted",
      { path: normalized, source },
      actor,
    );
    return requireView(writer.view);
  }

  revokeSensitivePath(
    sessionId: SessionId,
    path: string,
    reason: string,
    actor: EventActor = { kind: "user", id: "user" },
  ): SessionView {
    const writer = this.#writer(sessionId);
    requireView(writer.view);
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    if (!writer.view?.sensitivePathGrants[normalized]) return requireView(writer.view);
    writer.append("workspace.sensitive_path.revoked", { path: normalized, reason }, actor);
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
    const format = input.format ?? "legacy_items";
    writer.appendBatch([
      {
        type: "plan.revision.recorded",
        data: {
          planId: input.planId,
          revision,
          ...(format === "formal_markdown"
            ? { format: "formal_markdown" as const, markdown: requireFormalMarkdown(input) }
            : {}),
          title: input.title,
          overview: input.overview,
          artifactRef: input.artifactRef,
          sha256: input.sha256,
          path: input.path,
          ...(format === "legacy_items"
            ? {
                items: (input.items ?? []).map((item) => ({
                  planItemId: item.planItemId,
                  title: item.title,
                  description: item.description,
                  ...(item.verification === undefined ? {} : { verification: item.verification }),
                  ...(item.dependsOn.length === 0 ? {} : { dependsOn: [...item.dependsOn] }),
                })),
              }
            : {}),
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

  recordWorkPlanUpdate(
    sessionId: SessionId,
    refs: { runId: RunId; stepId: StepId; actionId: ActionId },
    input: WorkPlanUpdateInput,
  ): SessionView {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    const prior = input.workPlanId === undefined ? undefined : view.workPlans[input.workPlanId];
    if (input.workPlanId && !prior) throw new Error(`Work Plan ${input.workPlanId} does not exist`);
    if (input.workPlanId === undefined && input.plan.some((item) => item.workItemId !== undefined)) {
      throw new Error("A new Work Plan cannot supply workItemId; Qi assigns stable IDs on creation");
    }
    const workPlanId = input.workPlanId ?? (createId("wpl") as WorkPlanId);
    const priorIds = new Set(
      prior?.revisions[prior.latestRevision]?.items.map((item) => item.workItemId) ?? [],
    );
    const items = input.plan.map((item) => {
      if (item.workItemId && !priorIds.has(item.workItemId)) {
        throw new Error(`Work item ${item.workItemId} does not exist in ${workPlanId}`);
      }
      return {
        workItemId: item.workItemId ?? (createId("wit") as WorkItemId),
        step: item.step,
        status: item.status,
      };
    });
    const run = view.runs[refs.runId];
    const sourcePlan = run?.planBinding === undefined
      ? undefined
      : { planId: run.planBinding.planId, revision: run.planBinding.revision };
    writer.append("work.plan.updated", {
      workPlanId,
      revision: (prior?.latestRevision ?? 0) + 1,
      runId: refs.runId,
      stepId: refs.stepId,
      actionId: refs.actionId,
      ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
      ...(sourcePlan === undefined ? {} : { sourcePlan }),
      items,
    }, { kind: "agent", id: "update_plan" });
    return requireView(writer.view);
  }

  askRunQuestion(
    sessionId: SessionId,
    refs: { runId: RunId; stepId: StepId; actionId: ActionId },
    questions: readonly RunQuestionInput[],
  ): { view: SessionView; questionSetId: QuestionId } {
    const writer = this.#writer(sessionId);
    requireView(writer.view);
    const questionSetId = createId("qst") as QuestionId;
    writer.append("run.question.asked", {
      ...refs,
      questionSetId,
      questions: questions.map((question) => ({
        id: question.id,
        header: question.header,
        prompt: question.prompt,
        selection: question.selection,
        options: question.options.map((option) => ({ ...option })),
        ...(question.allowText === undefined ? {} : { allowText: question.allowText }),
      })),
    }, { kind: "agent", id: "ask_question" });
    return { view: requireView(writer.view), questionSetId };
  }

  answerRunQuestion(
    sessionId: SessionId,
    refs: { runId: RunId; stepId: StepId; actionId: ActionId; questionSetId: QuestionId },
    answers: readonly RunQuestionAnswer[],
  ): SessionView {
    const writer = this.#writer(sessionId);
    requireView(writer.view);
    writer.append("run.question.answered", {
      ...refs,
      answers: answers.map((answer) => ({
        questionId: answer.questionId,
        ...(answer.selectedOptionIds === undefined
          ? {}
          : { selectedOptionIds: [...answer.selectedOptionIds] }),
        ...(answer.text === undefined ? {} : { text: answer.text }),
        skipped: answer.skipped,
      })),
    }, { kind: "user", id: "user" });
    return requireView(writer.view);
  }

  cancelRunQuestion(
    sessionId: SessionId,
    refs: { runId: RunId; stepId: StepId; actionId: ActionId; questionSetId: QuestionId },
    reason: string,
  ): SessionView {
    const writer = this.#writer(sessionId);
    requireView(writer.view);
    writer.append(
      "run.question.cancelled",
      { ...refs, reason },
      { kind: "runtime", id: "question_control" },
    );
    return requireView(writer.view);
  }

  /** Accept Plan review, switch to Agent, and trigger its implementation Run atomically. */
  acceptPlanAndStartFirstRun(
    sessionId: SessionId,
    actor: EventActor = { kind: "user", id: "user" },
  ): { view: SessionView; runId: RunId; planItemId?: PlanItemId; input: string; formal: boolean } {
    const writer = this.#writer(sessionId);
    const view = requireView(writer.view);
    const pending = view.pendingReview;
    if (!pending || pending.status !== "pending") {
      throw new Error("No pending Plan review to accept");
    }
    const plan = view.plans[pending.planId];
    const revision = plan?.revisions[pending.revision];
    if (!plan || !revision) throw new Error("Pending Plan revision is missing");
    const formal = revision.format === "formal_markdown";
    const first = formal ? undefined : firstIncompleteItem(view, pending.planId, pending.revision);
    if (!formal && !first) throw new Error("Plan has no incomplete items to execute");
    const runId = createId("run") as RunId;
    const input = formal
      ? formatAcceptedPlanInput(pending.planId, revision)
      : formatPlanItemInput(revision.title, first!);
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
            ...(first === undefined ? {} : { planItemId: first.planItemId }),
          },
        },
        actor,
      },
    ]);
    return {
      view: requireView(writer.view),
      runId,
      ...(first === undefined ? {} : { planItemId: first.planItemId }),
      input,
      formal,
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
    const revision = view.plans[run.planBinding.planId]?.revisions[run.planBinding.revision];
    if (revision?.format === "formal_markdown") return undefined;
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
    if (!plan) return undefined;
    const revision = plan?.acceptedRevision;
    if (revision === undefined) return undefined;
    if (plan.revisions[revision]?.format === "formal_markdown") return undefined;
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
  if (!rev || rev.format === "formal_markdown") return undefined;
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

export interface WorkPlanUpdateInput {
  workPlanId?: WorkPlanId;
  explanation?: string;
  plan: ReadonlyArray<{
    workItemId?: WorkItemId;
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

export interface RunQuestionInput {
  id: string;
  header: string;
  prompt: string;
  selection: "single" | "multiple" | "text";
  options: ReadonlyArray<{ id: string; label: string; description?: string }>;
  allowText?: boolean;
}

export interface RunQuestionAnswer {
  questionId: string;
  selectedOptionIds?: readonly string[];
  text?: string;
  skipped: boolean;
}

function formatAcceptedPlanInput(
  planId: PlanId,
  revision: PlanRevisionView,
): string {
  if (revision.format !== "formal_markdown" || !revision.markdown) {
    throw new Error("Accepted Formal Plan Markdown is missing");
  }

  return [
    `<accepted-plan id="${planId}" revision="${revision.revision}" sha256="${revision.sha256}">`,
    revision.markdown.trim(),
    "</accepted-plan>",
    "",
    "Implement the accepted plan. Use update_plan only when the implementation is complex enough to benefit from a work Todo.",
  ].join("\n");
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

function requireFormalMarkdown(input: PlanRevisionInput): string {
  if (!input.markdown) throw new Error("Formal Plan Markdown is required");
  return input.markdown;
}
