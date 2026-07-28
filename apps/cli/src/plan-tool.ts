import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactSensitiveText } from "@civaapple/qi-agent/capability";
import type { HumanControlService } from "@civaapple/qi-agent/loop";
import { createId, type PlanId, type RunId, type SessionId } from "@civaapple/qi-protocol";
import { ToolFailure, defineTool, type ArtifactStore } from "@civaapple/qi-node/tools";
import { Type, type Static } from "@sinclair/typebox";

const MAX_PLAN_BYTES = 64 * 1024;
const MAX_READ_LINES = 400;
const PlanIdSchema = Type.String({ pattern: "^pln_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$" });

const PlanDocumentInputSchema = Type.Union([
  Type.Object({
    operation: Type.Literal("create"),
    markdown: Type.String({ minLength: 1, maxLength: MAX_PLAN_BYTES }),
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("read"),
    planId: Type.Optional(PlanIdSchema),
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("edit"),
    planId: PlanIdSchema,
    expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    edits: Type.Array(Type.Object({
      oldText: Type.String({ minLength: 1, maxLength: MAX_PLAN_BYTES }),
      newText: Type.String({ maxLength: MAX_PLAN_BYTES }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
  }, { additionalProperties: false }),
]);

type PlanDocumentInput = Static<typeof PlanDocumentInputSchema>;

export interface PlanToolDeps {
  dataRoot: string;
  artifactStore: ArtifactStore;
  humanControl: HumanControlService;
}

/** Plan-mode-only immutable Formal Plan document store. */
export function createPlanDocumentTool(deps: PlanToolDeps) {
  return defineTool({
    description:
      "Create, read, or atomically edit the managed Formal Plan Markdown. Create requires a complete, " +
      "self-contained document. Edit requires the latest SHA-256 and up to 16 unique oldText/newText patches. " +
      "Formal Plans are design documents, not Todo lists, so task-list checkboxes are rejected.",
    input: PlanDocumentInputSchema,
    output: Type.Object({
      operation: Type.Union([Type.Literal("create"), Type.Literal("read"), Type.Literal("edit")]),
      planId: Type.String(),
      revision: Type.Integer({ minimum: 1 }),
      sha256: Type.String(),
      path: Type.String(),
      artifactRef: Type.String(),
      title: Type.String(),
      overview: Type.String(),
      markdown: Type.Optional(Type.String()),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      totalLines: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),
    effect: (input: PlanDocumentInput) => input.operation === "read" ? "read" : "write",
    resources: (input: PlanDocumentInput) => [
      `plan:document:${"planId" in input && input.planId ? input.planId : "current"}`,
    ],
    execute: async (input: PlanDocumentInput, context) => {
      const sessionId = context.sessionId as SessionId;
      if (input.operation === "read") {
        const view = deps.humanControl.view(sessionId);
        const planId = (input.planId ?? view?.currentPlanId) as PlanId | undefined;
        if (!planId) throw new ToolFailure("PLAN_NOT_FOUND", "No current Formal Plan exists");
        const plan = view?.plans[planId];
        const revisionNumber = input.revision ?? plan?.latestRevision;
        const revision = revisionNumber === undefined ? undefined : plan?.revisions[revisionNumber];
        if (!revision || revision.format !== "formal_markdown" || !revision.markdown) {
          throw new ToolFailure("PLAN_NOT_FOUND", `Formal Plan ${planId} revision ${revisionNumber ?? "latest"} does not exist`);
        }
        const lines = revision.markdown.split(/\r?\n/);
        const startLine = input.startLine ?? 1;
        const requestedEnd = input.endLine ?? Math.min(lines.length, startLine + MAX_READ_LINES - 1);
        if (requestedEnd < startLine) {
          throw new ToolFailure("PLAN_LINE_RANGE", "endLine must be greater than or equal to startLine");
        }
        const endLine = Math.min(requestedEnd, lines.length, startLine + MAX_READ_LINES - 1);
        return {
          operation: "read" as const,
          planId,
          revision: revision.revision,
          sha256: revision.sha256,
          path: revision.path,
          artifactRef: revision.artifactRef,
          title: revision.title,
          overview: revision.overview,
          markdown: lines.slice(startLine - 1, endLine).join("\n"),
          startLine,
          endLine,
          totalLines: lines.length,
        };
      }

      let planId: PlanId;
      let markdown: string;
      if (input.operation === "create") {
        planId = createId("pln") as PlanId;
        markdown = input.markdown;
      } else {
        planId = input.planId as PlanId;
        const view = deps.humanControl.view(sessionId);
        const plan = view?.plans[planId];
        const revision = plan?.revisions[plan.latestRevision];
        if (!revision || revision.format !== "formal_markdown" || !revision.markdown) {
          throw new ToolFailure("PLAN_NOT_FOUND", `Formal Plan ${planId} does not exist`);
        }
        if (revision.sha256 !== input.expectedSha256) {
          throw new ToolFailure("PLAN_SHA_MISMATCH", "Formal Plan changed; read the latest revision before editing");
        }
        markdown = applyAtomicEdits(revision.markdown, input.edits);
      }

      const metadata = validateFormalPlan(markdown);
      const content = Buffer.from(markdown, "utf8");
      const stored = await deps.artifactStore.put(content, "text/markdown; charset=utf-8");
      const revisionDir = resolve(deps.dataRoot, "plans", planId);
      await mkdir(revisionDir, { recursive: true });
      const path = join(revisionDir, `${stored.sha256}.md`);
      await writeFile(path, content, { flag: "wx" }).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
          throw error;
        }
      });
      try {
        const view = deps.humanControl.recordPlanRevision(sessionId, {
          planId,
          format: "formal_markdown",
          title: metadata.title,
          overview: metadata.overview,
          markdown,
          artifactRef: stored.ref,
          sha256: stored.sha256,
          path,
          sourceRunId: context.runId as RunId,
        });
        const revision = view.plans[planId]?.latestRevision;
        if (!revision) throw new Error("Plan revision was not projected after record");
        return {
          operation: input.operation,
          planId,
          revision,
          sha256: stored.sha256,
          path,
          artifactRef: stored.ref,
          title: metadata.title,
          overview: metadata.overview,
        };
      } catch (error) {
        throw new ToolFailure(
          "PLAN_REVISION_REJECTED",
          error instanceof Error ? error.message : "Failed to record Formal Plan revision",
        );
      }
    },
  });
}

export function validateFormalPlan(markdown: string): { title: string; overview: string } {
  if (Buffer.byteLength(markdown, "utf8") > MAX_PLAN_BYTES) {
    throw new ToolFailure("PLAN_TOO_LARGE", "Formal Plan exceeds 64 KiB UTF-8");
  }
  const redacted = redactSensitiveText(markdown);
  if (redacted.redactions.length > 0) {
    throw new ToolFailure("PLAN_SECRET_REJECTED", "Formal Plan contains a detected secret value");
  }
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/m.test(markdown)) {
    throw new ToolFailure("PLAN_TODO_REJECTED", "Formal Plan must not contain task-list checkboxes");
  }
  const lines = markdown.split(/\r?\n/);
  const first = lines.find((line) => line.trim().length > 0);
  const h1s = lines.filter((line) => /^#\s+\S/.test(line));
  if (!first || !/^#\s+\S/.test(first) || h1s.length !== 1) {
    throw new ToolFailure("PLAN_H1_REQUIRED", "The first non-empty line must be the document's unique H1");
  }
  const title = first.replace(/^#\s+/, "").trim();
  const overview = extractOverview(lines);
  if (!overview) {
    throw new ToolFailure("PLAN_OVERVIEW_REQUIRED", "Formal Plan needs a summary paragraph after its H1");
  }
  return { title, overview };
}

function extractOverview(lines: readonly string[]): string {
  const paragraphs: string[] = [];
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraphs.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      if (paragraphs.length > 0) break;
      continue;
    }
    paragraphs.push(trimmed);
  }
  return paragraphs.join(" ").slice(0, 8_000);
}

function applyAtomicEdits(
  source: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): string {
  let next = source;
  for (const edit of edits) {
    const first = next.indexOf(edit.oldText);
    const last = next.lastIndexOf(edit.oldText);
    if (first < 0) throw new ToolFailure("PLAN_EDIT_NOT_FOUND", "An oldText patch target was not found");
    if (first !== last) throw new ToolFailure("PLAN_EDIT_AMBIGUOUS", "An oldText patch target is not unique");
    if (edit.oldText === edit.newText) throw new ToolFailure("PLAN_EDIT_NOOP", "A Plan edit must change the document");
    next = `${next.slice(0, first)}${edit.newText}${next.slice(first + edit.oldText.length)}`;
  }
  return next;
}

/** Legacy renderer retained for historical replay fixtures only. */
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
    lines.push(`- [ ] ${item.title} <!-- ${item.planItemId} -->`, "", item.description.trim(), "");
  }
  return `${lines.join("\n").trim()}\n`;
}
