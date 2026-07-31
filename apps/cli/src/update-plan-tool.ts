import type { HumanControlService } from "@civaapple/qi-agent/loop";
import type {
  ActionId,
  RunId,
  SessionId,
  StepId,
  WorkItemId,
  WorkPlanId,
} from "@civaapple/qi-protocol";
import { ToolFailure, defineTool } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const WorkPlanInputSchema = Type.Object({
  workPlanId: Type.Optional(Type.String({
    pattern: "^wpl_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$",
    description: "Omit when creating. For updates, use only the workPlanId returned by a successful prior call; never invent one.",
  })),
  explanation: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  plan: Type.Array(Type.Object({
    workItemId: Type.Optional(Type.String({
      pattern: "^wit_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$",
      description: "Omit for every item on create. On update, preserve IDs returned by the last successful snapshot; never invent one.",
    })),
    step: Type.String({ minLength: 1, maxLength: 1_000 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
    ]),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

type WorkPlanInput = Static<typeof WorkPlanInputSchema>;

export function createUpdatePlanTool(humanControl: HumanControlService) {
  return defineTool({
    description:
      "Create or update a Work Plan/Todo to focus multi-step work in Plan or Agent (research, drafting, " +
      "implementation, or Goal slices). Skip it for simple one-shot tasks. Each call replaces the item list: " +
      "change status, rewrite step text, add items (omit workItemId), or drop items as reality changes. " +
      "On the first call omit workPlanId and every workItemId; Qi assigns and returns stable IDs. On later " +
      "calls use only IDs from the last successful output or the Runtime Work Plan navigation context. " +
      "Omitting workPlanId while supplying known workItemId values continues the Session's current Work Plan. " +
      "Omitting workPlanId and every workItemId creates a fresh Work Plan for a new complex slice (common " +
      "after finishing a prior Todo under a long Goal). Keep at most one item in_progress. This is " +
      "navigation, not completion or Goal evidence.",
    input: WorkPlanInputSchema,
    output: Type.Object({
      workPlanId: Type.String(),
      revision: Type.Integer({ minimum: 1 }),
      explanation: Type.Optional(Type.String()),
      plan: Type.Array(Type.Object({
        workItemId: Type.String(),
        step: Type.String(),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ]),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    effect: () => "read",
    resources: (input: WorkPlanInput) => [
      `work-plan:${input.workPlanId ?? "new"}`,
    ],
    execute: async (input: WorkPlanInput, context) => {
      if (input.plan.filter((item) => item.status === "in_progress").length > 1) {
        throw new ToolFailure("WORK_PLAN_IN_PROGRESS", "At most one Work Plan item may be in_progress");
      }
      try {
        const view = humanControl.recordWorkPlanUpdate(
          context.sessionId as SessionId,
          {
            runId: context.runId as RunId,
            stepId: context.stepId as StepId,
            actionId: context.actionId as ActionId,
          },
          {
            ...(input.workPlanId === undefined ? {} : { workPlanId: input.workPlanId as WorkPlanId }),
            ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
            plan: input.plan.map((item) => ({
              ...(item.workItemId !== undefined ? { workItemId: item.workItemId as WorkItemId } : {}),
              step: item.step,
              status: item.status,
            })),
          },
        );
        const workPlanId = (input.workPlanId ?? view.currentWorkPlanId) as WorkPlanId | undefined;
        const workPlan = workPlanId === undefined ? undefined : view.workPlans[workPlanId];
        const revision = workPlan?.latestRevision;
        const snapshot = revision === undefined ? undefined : workPlan?.revisions[revision];
        if (!workPlanId || !revision || !snapshot) throw new Error("Work Plan update was not projected");
        return {
          workPlanId,
          revision,
          ...(snapshot.explanation === undefined ? {} : { explanation: snapshot.explanation }),
          plan: snapshot.items,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Work Plan update was rejected";
        throw new ToolFailure(
          "WORK_PLAN_REJECTED",
          `${detail}. To create a Work Plan, omit workPlanId and every workItemId. ` +
          "To continue the current Work Plan, omit workPlanId and supply only workItemId values from the " +
          "last successful snapshot (or Runtime Work Plan context). To update a named plan, pass its " +
          "workPlanId with those same IDs.",
        );
      }
    },
  });
}
