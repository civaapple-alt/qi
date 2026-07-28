import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HumanControlService } from "@civaapple/qi-agent/loop";
import { createId, type PlanId, type PlanItemId, type RunId } from "@civaapple/qi-protocol";
import { ToolFailure, defineTool, type ArtifactStore } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const PlanDocumentInputSchema = Type.Object(
  {
    planId: Type.Optional(Type.String({ pattern: "^pln_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" })),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    overview: Type.String({ minLength: 1, maxLength: 8_000 }),
    items: Type.Array(
      Type.Object(
        {
          planItemId: Type.Optional(Type.String({ pattern: "^pit_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" })),
          title: Type.String({ minLength: 1, maxLength: 200 }),
          description: Type.String({ minLength: 1, maxLength: 4_000 }),
          verification: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
          dependsOn: Type.Optional(
            Type.Array(Type.String({ pattern: "^pit_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" }), {
              maxItems: 32,
              uniqueItems: true,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

type PlanDocumentInput = Static<typeof PlanDocumentInputSchema>;

export interface PlanToolDeps {
  dataRoot: string;
  artifactStore: ArtifactStore;
  humanControl: HumanControlService;
}

/** Plan-mode-only tool: writes managed Markdown and records a durable Plan revision + review request. */
export function createPlanDocumentTool(deps: PlanToolDeps) {
  return defineTool({
    description:
      "Record the Session Plan as managed Markdown (not a Workspace file edit). Provide a title, overview, and " +
      "ordered items with stable planItemId values when revising. After success the human must accept the Plan " +
      "review before any Agent execution Run starts.",
    input: PlanDocumentInputSchema,
    output: Type.Object(
      {
        planId: Type.String(),
        revision: Type.Integer({ minimum: 1 }),
        path: Type.String(),
        artifactRef: Type.String(),
        itemCount: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    effect: () => "write",
    resources: () => ["plan:document"],
    execute: async (input: PlanDocumentInput, context) => {
      const planId = (input.planId ?? createId("pln")) as PlanId;
      const items = input.items.map((item) => ({
        planItemId: (item.planItemId ?? createId("pit")) as PlanItemId,
        title: item.title,
        description: item.description,
        ...(item.verification === undefined ? {} : { verification: item.verification }),
        dependsOn: [...(item.dependsOn ?? [])] as PlanItemId[],
      }));
      const markdown = renderPlanMarkdown(input.title, input.overview, items);
      const stored = await deps.artifactStore.put(
        Buffer.from(markdown, "utf8"),
        "text/markdown; charset=utf-8",
      );
      const plansDir = resolve(deps.dataRoot, "plans");
      await mkdir(plansDir, { recursive: true });
      const path = join(plansDir, `${planId}.md`);
      await writeFile(path, markdown, "utf8");
      try {
        const view = deps.humanControl.recordPlanRevision(context.sessionId as import("@civaapple/qi-protocol").SessionId, {
          planId,
          title: input.title,
          overview: input.overview,
          artifactRef: stored.ref,
          sha256: stored.sha256,
          path,
          items,
          sourceRunId: context.runId as RunId,
        });
        const revision = view.plans[planId]?.latestRevision;
        if (!revision) {
          throw new ToolFailure("PLAN_REVISION_MISSING", "Plan revision was not projected after record");
        }
        return {
          planId,
          revision,
          path,
          artifactRef: stored.ref,
          itemCount: items.length,
        };
      } catch (error) {
        throw new ToolFailure(
          "PLAN_REVISION_REJECTED",
          error instanceof Error ? error.message : "Failed to record Plan revision",
        );
      }
    },
  });
}

export function renderPlanMarkdown(
  title: string,
  overview: string,
  items: ReadonlyArray<{
    planItemId: string;
    title: string;
    description: string;
    verification?: string;
    dependsOn: readonly string[];
  }>,
): string {
  const lines = [`# ${title}`, "", overview.trim(), "", "## Checklist", ""];
  for (const item of items) {
    lines.push(`- [ ] ${item.title} <!-- ${item.planItemId} -->`);
    lines.push("");
    lines.push(item.description.trim());
    if (item.verification) {
      lines.push("");
      lines.push(`Verification: ${item.verification.trim()}`);
    }
    if (item.dependsOn.length > 0) {
      lines.push("");
      lines.push(`Depends on: ${item.dependsOn.join(", ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}
