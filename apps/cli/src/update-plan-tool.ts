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
  workPlanId: Type.Optional(Type.String({ pattern: "^wpl_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" })),
  explanation: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  plan: Type.Array(Type.Object({
    workItemId: Type.Optional(Type.String({ pattern: "^wit_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" })),
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
      "Create or update the implementation Work Plan/Todo for a complex Agent task. Use it for cross-package, " +
      "three-or-more-step, phased migration, or multi-round verification work; skip it for simple tasks. " +
      "Keep at most one item in_progress. This is navigation, not completion evidence.",
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
              ...(item.workItemId === undefined ? {} : { workItemId: item.workItemId as WorkItemId }),
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
        throw new ToolFailure(
          "WORK_PLAN_REJECTED",
          error instanceof Error ? error.message : "Work Plan update was rejected",
        );
      }
    },
  });
}
