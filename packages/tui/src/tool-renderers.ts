import type { ActionStatus } from "@civaapple/qi-agent/kernel";
import { theme } from "./theme/index.js";
import { DEFAULT_TIMELINE_DENSITY } from "./timeline/policy.js";
import type { TimelineDensity } from "./timeline/types.js";

export interface ToolCardModel {
  actionId: string;
  toolName: string;
  effect?: string;
  status: ActionStatus;
  input?: unknown;
  output?: Record<string, unknown>;
  errorCode?: string;
  /** Human-readable settlement evidence (e.g. indeterminate reason). */
  detail?: string;
  /** Optional recovery guidance shown with indeterminate/cancelled cards. */
  hint?: string;
  /**
   * Optional human subject for opaque tool inputs (e.g. read_image → `image #1 · path`).
   * When set, dedicated renderers prefer this over raw JSON.
   */
  subjectHint?: string;
  elapsed?: string;
  resources?: readonly string[];
  liveTail?: { stream: "stdout" | "stderr" | "model"; text: string; droppedLines: number };
}

export interface ToolCardOptions {
  expanded?: boolean;
  outputLines?: number;
  density?: TimelineDensity;
  /** One-line header only — used for collapsed prior Steps inside a long active Run. */
  summaryOnly?: boolean;
}

type Renderer = (model: ToolCardModel, options: ToolCardOptions) => string[];

const renderers: Record<string, Renderer> = {
  shell: renderProcess,
  script: renderProcess,
  verify: renderProcess,
  write: renderMutation,
  edit: renderMutation,
  move: renderMutation,
  remove: renderMutation,
  read: renderDiscovery,
  list: renderDiscovery,
  tree: renderDiscovery,
  find: renderDiscovery,
  search: renderDiscovery,
  git: renderDiscovery,
  fetch: renderFetch,
  skill: renderSkill,
  artifact: renderArtifact,
  task: renderTask,
  delegate: renderDelegate,
  plan_document: renderPlanDocument,
  update_plan: renderWorkPlan,
  ask_question: renderAskQuestion,
  memory: renderMemory,
  read_image: renderReadImage,
};

function renderMemory(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const scope = String(output?.scope ?? input?.scope ?? "current");
  const result = String(output?.status ?? model.errorCode ?? model.status);
  const statement = typeof input?.statement === "string" ? input.statement : "Memory proposal";
  const lines = [header(model, `Memory · ${scope}`, result)];
  if (!options.summaryOnly) lines.push(`  ${oneLine(statement, 110)}`);
  if (output?.requiresConfirmation === true) lines.push("  pending user confirmation · /memory list pending");
  return lines;
}

function renderReadImage(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const artifactRef = typeof input?.artifactRef === "string" ? input.artifactRef : undefined;
  const region = record(input?.region);
  const outRegion = record(output?.region);
  const regionSource = outRegion ?? region;
  const regionLabel = regionSource
    && Number.isInteger(regionSource.x)
    && Number.isInteger(regionSource.y)
    && Number.isInteger(regionSource.width)
    && Number.isInteger(regionSource.height)
    ? `crop ${regionSource.x},${regionSource.y} ${regionSource.width}×${regionSource.height}`
    : "full";
  const sizeLabel = Number.isInteger(output?.width) && Number.isInteger(output?.height)
    ? `${output!.width}×${output!.height}`
    : undefined;
  const attachment = model.subjectHint
    ?? (artifactRef ? shortArtifactRef(artifactRef) : "image");
  const subject = [attachment, regionLabel, sizeLabel].filter(Boolean).join(" · ");
  const lines = [header(model, subject, model.errorCode)];
  if (options.summaryOnly) return lines;
  if (model.detail && (model.status === "indeterminate" || model.status === "cancelled" || model.status === "failed")) {
    lines.push(`  ${oneLine(model.detail, 110)}`);
  }
  if (model.hint && model.status === "indeterminate") lines.push(`  ${oneLine(model.hint, 110)}`);
  if (options.expanded && artifactRef && model.subjectHint) {
    lines.push(`  ${shortArtifactRef(artifactRef)}`);
  }
  return lines;
}

function shortArtifactRef(ref: string): string {
  const digest = ref.replace(/^artifact:\/\//, "");
  if (digest.length <= 16) return ref;
  return `art_${digest.slice(0, 8)}…${digest.slice(-4)}`;
}

export function renderToolCard(model: ToolCardModel, options: ToolCardOptions = {}): string[] {
  return (renderers[model.toolName] ?? renderGeneric)(model, options);
}

export function shouldExpandByDefault(status: ActionStatus): boolean {
  return status === "failed" || status === "denied" || status === "indeterminate" || status === "running";
}

/** Distinct settlement glyphs — never collapse failed/denied/cancelled/indeterminate. */
export function statusGlyph(status: ActionStatus): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "!";
  if (status === "denied") return "⊘";
  if (status === "indeterminate") return "?";
  if (status === "cancelled") return "×";
  if (status === "running") return "●";
  return "○";
}

function coloredGlyph(status: ActionStatus): string {
  const glyph = statusGlyph(status);
  if (status === "completed") return theme.fg("success", glyph);
  if (status === "failed") return theme.fg("error", glyph);
  if (status === "denied" || status === "indeterminate") return theme.fg("warning", glyph);
  if (status === "cancelled") return theme.fg("textDim", glyph);
  if (status === "running") return theme.fg("primary", glyph);
  return theme.fg("textDim", glyph);
}

function renderProcess(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const command = model.toolName === "verify"
    ? `verify ${String(input?.profile ?? "?")}`
    : model.toolName === "script"
      ? `${String(input?.profile ?? "?")} ${oneLine(String(input?.script ?? ""), 80)}`
      : [String(input?.command ?? "?"), ...(Array.isArray(input?.args) ? input.args.map(shellArg) : [])].join(" ");
  const workdir = typeof input?.workdir === "string" ? input.workdir : undefined;
  const envelope = model.output;
  const output = processPayload(envelope);
  const stderr = typeof output?.stderr === "string" ? output.stderr : "";
  const stdout = typeof output?.stdout === "string" ? output.stdout : "";
  const message = typeof envelope?.message === "string" ? envelope.message : "";
  const stream = stderr || stdout || message;
  const streamLines = stream ? normalizedLines(stream) : [];
  const duration = model.elapsed ?? (model.status === "running" ? undefined : "0ms");
  const prefix = model.toolName === "shell" ? "$" : model.toolName === "script" ? ">" : "#";
  const exitSummary = output?.timedOut === true
    ? "timed out"
    : "exitCode" in (output ?? {}) && output?.exitCode !== undefined
      ? `exit ${String(output.exitCode)}`
      : undefined;
  const title = [
    coloredGlyph(model.status),
    `${prefix} ${oneLine(command, 100)}`,
    duration,
    model.status !== "completed" && model.status !== "running" ? `· ${model.status}` : undefined,
    model.errorCode && model.status !== "completed" ? `· ${model.errorCode}` : undefined,
    exitSummary && model.status !== "completed" ? `· ${exitSummary}` : undefined,
  ].filter(Boolean).join(" ");
  if (options.summaryOnly) {
    const lines = [title];
    if (model.status !== "completed") appendProcessTail(lines, streamLines, 3);
    if (model.status === "indeterminate" && model.detail) lines.push(`  ${oneLine(model.detail, 110)}`);
    return lines;
  }
  const lines = [title];
  const density = options.density ?? DEFAULT_TIMELINE_DENSITY;

  if (model.status === "running" || model.liveTail?.text) {
    const live = model.liveTail?.text
      ? tailLines(model.liveTail.text, 3)
      : ["running…"];
    for (const line of live) lines.push(`  · ${oneLine(line, 110)}`);
  } else {
    if (exitSummary && model.status !== "completed") lines.push(`  ${exitSummary}`);
    if (
      !options.expanded
      && streamLines.length > 0
      && (model.status !== "completed" || density === "diagnostic")
    ) {
      const visible = Math.min(3, streamLines.length);
      const hidden = Math.max(0, streamLines.length - visible);
      if (hidden > 0) lines.push(`  … ${hidden} output lines hidden · Ctrl+O to expand`);
      for (const line of streamLines.slice(-visible)) {
        lines.push(`  ${oneLine(line, 110)}`);
      }
    }
  }

  if (options.expanded) {
    if (workdir && workdir !== ".") lines.push(`  cwd ${workdir}`);
    if (model.detail && (model.status === "indeterminate" || model.status === "cancelled" || model.status === "failed")) {
      lines.push(`  ${oneLine(model.detail, 110)}`);
    }
    if (model.hint && model.status === "indeterminate") {
      lines.push(`  ${oneLine(model.hint, 110)}`);
    }
    appendBounded(lines, stderr, options.outputLines ?? 12, "stderr");
    appendBounded(lines, stdout, options.outputLines ?? 12, "stdout");
    if (!stderr && !stdout) appendBounded(lines, message, options.outputLines ?? 12, "message");
    if (record(output?.workspaceChange)?.changed) lines.push("  workspace changed");
  }
  return lines;
}

function renderMutation(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const path = String(output?.path ?? input?.path ?? input?.from ?? "file");
  const diff = typeof output?.diff === "string" ? output.diff : "";
  const stats = diffStats(diff);
  const statsLabel = formatMutationStats(stats);
  const destination = typeof input?.to === "string" ? input.to : undefined;
  const displayPath = mutationDisplayPath(path);
  if (options.summaryOnly) {
    return [header(
      model,
      `${displayPath}${destination ? ` → ${mutationDisplayPath(destination)}` : ""}`,
      statsLabel ?? model.errorCode,
    )];
  }
  const lines = [mutationHeader(model, displayPath, destination, statsLabel)];

  // Cursor-style body: gutter + change lines with nearby context; hide ---/+++ / @@ chrome.
  // Collapsed cards need a real context budget — do not inherit the shared 4-line Action default.
  if (diff) {
    const collapsedBudget = 20;
    const limit = options.expanded
      ? Math.max(48, options.outputLines ?? 48)
      : Math.max(collapsedBudget, options.outputLines ?? collapsedBudget);
    appendDiffPreview(lines, diff, limit);
  }
  if (options.expanded && typeof output?.backupRef === "string") lines.push(`  recovery ${output.backupRef}`);
  if (model.detail && (model.status === "indeterminate" || model.status === "cancelled" || model.status === "failed")) {
    lines.push(`  ${oneLine(model.detail, 110)}`);
  }
  if (model.hint && model.status === "indeterminate") lines.push(`  ${oneLine(model.hint, 110)}`);
  return lines;
}

function mutationHeader(
  model: ToolCardModel,
  displayPath: string,
  destination: string | undefined,
  statsLabel: string | undefined,
): string {
  if (model.status === "completed") {
    const verb = model.toolName === "remove"
      ? "Removed"
      : model.toolName === "move"
        ? "Moved"
        : "Edited";
    const subject = model.toolName === "move" && destination
      ? `${displayPath} → ${mutationDisplayPath(destination)}`
      : displayPath;
    return [
      coloredGlyph(model.status),
      `${verb} ${subject}`,
      statsLabel,
      model.elapsed ? `· ${model.elapsed}` : undefined,
    ].filter(Boolean).join(" ");
  }
  return header(
    model,
    `${displayPath}${destination ? ` → ${mutationDisplayPath(destination)}` : ""}`,
    statsLabel ?? model.errorCode,
  );
}

function mutationDisplayPath(path: string): string {
  // Keep the full Workspace-relative path so edit/write cards match read discovery paths.
  return path.replaceAll("\\", "/");
}

/** Cursor-style `+17 -3` / `+1` (omit zero sides). */
function formatMutationStats(stats: { additions: number; removals: number }): string | undefined {
  if (stats.additions === 0 && stats.removals === 0) return undefined;
  if (stats.removals === 0) return `+${stats.additions}`;
  if (stats.additions === 0) return `-${stats.removals}`;
  return `+${stats.additions} -${stats.removals}`;
}

function renderDiscovery(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const subject = discoverySubject(model.toolName, input);
  const result = discoveryResult(model.toolName, output) ?? model.errorCode;
  if (options.summaryOnly) {
    const lines = [header(model, subject, result)];
    if (model.toolName === "git" && model.status === "failed") {
      const message = gitFailureMessage(output);
      if (message) lines.push(`  ${oneLine(message, 110)}`);
    }
    return lines;
  }
  const lines = [header(model, subject, result)];
  // read stays header-only (path · N lines); never dump file contents into the transcript.
  if (model.toolName === "search" && Array.isArray(output?.matches) && output.matches.length > 0) {
    const limit = options.expanded ? 8 : 4;
    for (const match of output.matches.slice(0, limit)) {
      const row = record(match);
      if (!row) continue;
      const loc = [row.path, row.line].filter((part) => part !== undefined && part !== "").join(":");
      const text = typeof row.text === "string" ? row.text : typeof row.lineText === "string" ? row.lineText : "";
      lines.push(`  ${oneLine([loc, text].filter(Boolean).join(" · "), 110)}`);
    }
    if (output.matches.length > limit) {
      lines.push(`  … ${output.matches.length - limit} more matches · Ctrl+O to expand`);
    }
  } else if (model.toolName === "git") {
    if (model.status === "failed") {
      const message = gitFailureMessage(output);
      if (message) lines.push(`  ${oneLine(message, 110)}`);
      const command = gitFailureCommand(output);
      // Request already on the header when input is present; show spawned argv when available.
      if (command && command !== subject) lines.push(`  ${oneLine(command, 110)}`);
    } else {
      const stream = typeof output?.stdout === "string" && output.stdout.trim()
        ? output.stdout
        : typeof output?.output === "string" && output.output.trim()
          ? output.output
          : undefined;
      if (stream) appendBounded(lines, stream, options.expanded ? 12 : 6, "stdout");
    }
  }
  return lines;
}

function renderFetch(model: ToolCardModel): string[] {
  const input = record(model.input);
  const output = model.output;
  const url = String(output?.finalUrl ?? input?.url ?? "URL");
  let host = url;
  try { host = new URL(url).host; } catch { /* retain bounded URL-like input */ }
  const result = output
    ? [output.status, output.mediaType, output.rawBytes === undefined ? undefined : `${output.rawBytes} B`, output.untrusted ? "untrusted" : undefined]
      .filter(Boolean).join(" · ")
    : model.errorCode;
  return [header(model, host, result)];
}

function renderSkill(model: ToolCardModel): string[] {
  const input = record(model.input);
  const output = model.output;
  const subject = [input?.operation, input?.name ?? output?.name].filter(Boolean).join(" · ") || "skill";
  const result = [output?.version, output?.scope].filter(Boolean).join(" · ") || model.errorCode;
  return [header(model, subject, result)];
}

function renderArtifact(model: ToolCardModel): string[] {
  const output = model.output;
  const result = [output?.size === undefined ? undefined : `${output.size} B`, output?.sha256].filter(Boolean).join(" · ") || model.errorCode;
  return [header(model, String(output?.ref ?? "artifact"), result)];
}

function renderTask(model: ToolCardModel, options: ToolCardOptions = {}): string[] {
  const input = record(model.input);
  const output = model.output;
  const command = [String(input?.command ?? "process"), ...(Array.isArray(input?.args) ? input.args.map(shellArg) : [])].join(" ");
  const result = output
    ? `${String(output.taskId ?? "task")} · pid ${String(output.pid ?? "?")} · expires ${String(output.expiresAt ?? "?")}`
    : model.errorCode;
  if (options.summaryOnly) return [header(model, command, result)];
  return [header(model, command, result), ...(output ? ["  detached as a bounded Job · /jobs"] : [])];
}

function renderDelegate(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const batchCount = Array.isArray(input?.tasks) ? input.tasks.length : 0;
  const subject = oneLine(
    String(
      input?.objective
        ?? (batchCount > 0 ? `${batchCount} subagents` : "subagent"),
    ),
    80,
  );
  const outcomes = Array.isArray(output?.results)
    ? output.results.map((item) => {
      const row = record(item);
      return typeof row?.outcome === "string" ? row.outcome : undefined;
    }).filter((item): item is string => Boolean(item))
    : typeof output?.outcome === "string"
      ? [output.outcome]
      : [];
  const primaryOutcome = outcomes.includes("timed_out")
    ? "timed_out"
    : outcomes.includes("cancelled")
      ? "cancelled"
      : outcomes.includes("failed") || outcomes.includes("rejected")
        ? "failed"
        : output?.accepted === true
          ? "accepted"
          : output?.accepted === false
            ? "rejected"
            : undefined;
  const visualStatus: ActionStatus = model.status === "running"
    ? "running"
    : primaryOutcome === "accepted"
      ? "completed"
      : primaryOutcome === "timed_out" || primaryOutcome === "failed" || primaryOutcome === "rejected"
        ? "failed"
        : primaryOutcome === "cancelled"
          ? "cancelled"
          : model.status;
  const result = output
    ? [
      primaryOutcome === "timed_out"
        ? "timed out"
        : primaryOutcome === "accepted"
          ? "accepted"
          : primaryOutcome ?? (output.accepted === false ? "rejected" : undefined),
      outcomes.length > 1 ? outcomes.join("+") : undefined,
      output.delegationId,
      output.summaryRef,
    ].filter(Boolean).join(" · ")
    : model.errorCode;
  const title = [
    coloredGlyph(visualStatus),
    model.toolName.padEnd(8),
    subject,
    model.elapsed ? `· ${model.elapsed}` : undefined,
    result ? `· ${oneLine(result, 80)}` : undefined,
  ].filter(Boolean).join(" ");
  if (options.summaryOnly) return [title];
  const lines = [title];
  if (typeof output?.parentHint === "string" && output.parentHint.trim()) {
    lines.push(`  ${oneLine(output.parentHint, 120)}`);
  }
  if (typeof output?.summary === "string" && output.summary.trim()) {
    if (options.expanded) {
      lines.push(...output.summary.split(/\r?\n/).map((line) => `  ${line}`));
    } else {
      lines.push(`  ${oneLine(output.summary, 120)}`);
    }
  }
  return lines;
}

function renderPlanDocument(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const title = String(output?.title ?? input?.title ?? formalPlanInputTitle(input) ?? "Formal Plan");
  const operation = typeof input?.operation === "string" ? input.operation : undefined;
  const items = Array.isArray(input?.items) ? input.items : [];
  const completed = model.status === "completed" && output !== undefined;
  const result = completed
    ? [
        operation,
        output.revision === undefined ? undefined : `rev ${String(output.revision)}`,
        output.itemCount === undefined ? undefined : `${String(output.itemCount)} items`,
      ].filter(Boolean).join(" · ")
    : [
        operation,
        model.errorCode ?? (items.length > 0 ? `${items.length} items` : undefined),
      ].filter(Boolean).join(" · ");
  if (options.summaryOnly) return [header(model, title, result)];
  const lines = [header(model, title, result)];
  if (!completed && typeof output?.message === "string" && output.message.trim()) {
    lines.push(`  ${oneLine(output.message, 110)}`);
  }
  if (typeof input?.overview === "string" && input.overview.trim()) {
    lines.push(`  ${oneLine(input.overview, 110)}`);
  }
  if (options.expanded && items.length > 0) {
    const limit = options.outputLines ?? 8;
    for (const item of items.slice(0, limit)) {
      const rec = record(item);
      if (!rec) continue;
      lines.push(`  • ${oneLine(String(rec.title ?? ""), 100)}`);
    }
    if (items.length > limit) lines.push(`  … ${items.length - limit} more items · /plan`);
  } else if (!options.expanded && items.length > 0) {
    lines.push(`  ${items.length} items · Ctrl+O to expand · /plan`);
  }
  if (typeof output?.path === "string") lines.push(`  ${output.path}`);
  return lines;
}

function formalPlanInputTitle(input: Record<string, unknown> | undefined): string | undefined {
  if (typeof input?.markdown !== "string") return undefined;
  const first = input.markdown.split(/\r?\n/).find((line) => line.trim());
  const match = first?.match(/^#\s+(.+)$/);
  return match?.[1]?.trim();
}

function renderWorkPlan(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const items = Array.isArray(output?.plan)
    ? output.plan
    : Array.isArray(input?.plan) ? input.plan : [];
  const completed = items.filter((item) => record(item)?.status === "completed").length;
  const activeCount = items.filter((item) => record(item)?.status === "in_progress").length;
  const title = activeCount > 0
    ? `To-do · Working on ${items.length} to-do${items.length === 1 ? "" : "s"}`
    : "To-do";
  const result = model.status === "completed" ? `${completed}/${items.length} done` : model.errorCode;
  const lines = [header(model, title, result)];
  if (options.summaryOnly) return lines;
  if (model.status !== "completed" && typeof output?.message === "string" && output.message.trim()) {
    lines.push(`  ${oneLine(output.message, 110)}`);
  }
  const explanation = String(output?.explanation ?? input?.explanation ?? "").trim();
  if (explanation) lines.push(`  ${oneLine(explanation, 110)}`);
  const limit = options.expanded
    ? Math.max(16, options.outputLines ?? 32)
    : Math.max(16, options.outputLines ?? 16);
  for (const item of items.slice(0, limit)) {
    const value = record(item);
    if (!value) continue;
    const status = value.status;
    const glyph = status === "completed" ? "✔" : status === "in_progress" ? "◐" : "○";
    lines.push(`  ${glyph} ${oneLine(String(value.step ?? ""), 108)}`);
  }
  if (items.length > limit) lines.push(`  … +${items.length - limit} more`);
  return lines;
}

function renderAskQuestion(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.status === "completed" ? model.output : undefined;
  const questions = Array.isArray(input?.questions)
    ? input.questions
        .map(record)
        .filter((question): question is Record<string, unknown> => Boolean(question))
    : [];
  const answers = new Map(
    (Array.isArray(output?.answers) ? output.answers : [])
      .map(record)
      .filter((answer): answer is Record<string, unknown> => Boolean(answer))
      .map((answer) => [String(answer.questionId ?? ""), answer]),
  );
  const skipped = [...answers.values()].filter((answer) => answer.skipped === true).length;
  const answered = answers.size - skipped;
  const result = model.status === "completed"
    ? [
        `${questions.length} question${questions.length === 1 ? "" : "s"}`,
        `${answered} answered`,
        skipped > 0 ? `${skipped} skipped` : undefined,
      ].filter(Boolean).join(" · ")
    : model.errorCode;
  const lines = [header(model, "User clarification", result)];
  if (options.summaryOnly) return lines;

  questions.forEach((question, questionIndex) => {
    const questionId = String(question.id ?? "");
    const answer = answers.get(questionId);
    const selection = String(question.selection ?? "single");
    const headerText = String(question.header ?? `Question ${questionIndex + 1}`);
    const prompt = String(question.prompt ?? "");
    const selected = new Set(
      Array.isArray(answer?.selectedOptionIds)
        ? answer.selectedOptionIds.map((optionId) => String(optionId))
        : [],
    );
    lines.push(`  ${questionIndex + 1}. ${oneLine(headerText, 100)} · ${selection}`);
    if (prompt.trim()) lines.push(`     ${oneLine(prompt, 110)}`);

    const questionOptions = Array.isArray(question.options)
      ? question.options
          .map(record)
          .filter((option): option is Record<string, unknown> => Boolean(option))
      : [];
    for (const option of questionOptions) {
      const optionId = String(option.id ?? "");
      const chosen = selected.has(optionId);
      const mark = selection === "multiple"
        ? (chosen ? "☑" : "☐")
        : (chosen ? "●" : "○");
      lines.push(`     ${mark} ${oneLine(String(option.label ?? optionId), 104)}`);
      if (typeof option.description === "string" && option.description.trim()) {
        lines.push(`       ${oneLine(option.description, 102)}`);
      }
    }

    if (answer?.skipped === true) {
      lines.push("     ↷ Skipped");
    } else if (typeof answer?.text === "string" && answer.text.trim()) {
      const answerLabel = selection === "text" ? "Answer" : "Other";
      lines.push(`     ✓ ${answerLabel}: ${oneLine(answer.text, 98)}`);
    } else if (model.status === "completed" && selected.size === 0) {
      lines.push("     ○ No answer recorded");
    }
  });
  return lines;
}

function renderGeneric(model: ToolCardModel, options: ToolCardOptions): string[] {
  const summary = oneLine(JSON.stringify(model.input ?? {}), 100);
  if (options.summaryOnly) {
    const lines = [header(model, summary, model.errorCode)];
    if (model.status === "indeterminate" && model.detail) lines.push(`  ${oneLine(model.detail, 110)}`);
    return lines;
  }
  const lines = [header(model, summary, model.errorCode)];
  if (model.detail && (model.status === "indeterminate" || model.status === "cancelled" || model.status === "failed")) {
    lines.push(`  ${oneLine(model.detail, 110)}`);
  }
  if (model.hint && model.status === "indeterminate") lines.push(`  ${oneLine(model.hint, 110)}`);
  if (model.liveTail?.text) {
    lines.push(...tailLines(model.liveTail.text, options.outputLines ?? 5).map((line) => `  ${line}`));
    lines.push(
      `  · live ${model.liveTail.stream}${model.liveTail.droppedLines ? ` · ${model.liveTail.droppedLines} earlier lines` : ""}`,
    );
  }
  return lines;
}

function header(model: ToolCardModel, subject: string, result?: string): string {
  return [
    coloredGlyph(model.status),
    model.toolName.padEnd(8),
    oneLine(subject, 100),
    model.elapsed ? `· ${model.elapsed}` : undefined,
    model.status !== "completed" ? `· ${model.status}` : undefined,
    result ? `· ${oneLine(result, 80)}` : undefined,
  ].filter(Boolean).join(" ");
}

function appendBounded(lines: string[], value: string, limit: number, label: string): void {
  if (!value) return;
  const all = normalizedLines(value);
  const hidden = Math.max(0, all.length - limit);
  if (hidden > 0) lines.push(`  ${label} · … ${hidden} lines hidden · Ctrl+O / Artifact for full`);
  else lines.push(`  ${label}`);
  lines.push(...all.slice(0, limit).map((line) => `    ${line}`));
}

/** True for unified-diff path / hunk chrome — not actual code or context lines. */
function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("diff --git ")
    || line.startsWith("index ")
    || line.startsWith("--- ")
    || line.startsWith("+++ ")
    || line.startsWith("@@")
    || line.startsWith("Binary files ")
    || line.startsWith("new file mode ")
    || line.startsWith("deleted file mode ")
    || line.startsWith("old mode ")
    || line.startsWith("new mode ")
    || line.startsWith("similarity index ")
    || line.startsWith("rename from ")
    || line.startsWith("rename to ")
    || line === "\\ No newline at end of file"
  );
}

function isDiffChangeLine(line: string): boolean {
  return (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---");
}

/**
 * Cursor-like unified-diff body: ▎ gutter, change lines plus nearby context, no ---/+++ / @@ chrome.
 * Collapse only surplus middle with an explicit truncated count.
 */
function appendDiffPreview(lines: string[], diff: string, limit: number): void {
  const body = normalizedLines(diff).filter((line) => !isDiffMeta(line));
  if (body.length === 0) return;
  if (body.length <= limit) {
    lines.push(...body.map(formatDiffBodyLine));
    return;
  }

  const important = body
    .map((line, index) => (isDiffChangeLine(line) ? index : -1))
    .filter((index) => index >= 0);
  const keep = new Set<number>();

  if (important.length === 0) {
    const head = Math.max(6, Math.ceil(limit * 0.7));
    const tail = Math.max(2, limit - head);
    for (let i = 0; i < head; i += 1) keep.add(i);
    for (let i = body.length - tail; i < body.length; i += 1) keep.add(i);
  } else if (important.length <= limit) {
    for (const index of important) keep.add(index);
    // Prefer a few context lines on both sides of each change (Cursor-style).
    let grew = true;
    while (keep.size < limit && grew) {
      grew = false;
      for (const index of [...keep].sort((a, b) => a - b)) {
        if (keep.size >= limit) break;
        if (index > 0 && !keep.has(index - 1)) {
          keep.add(index - 1);
          grew = true;
        }
        if (keep.size >= limit) break;
        if (index + 1 < body.length && !keep.has(index + 1)) {
          keep.add(index + 1);
          grew = true;
        }
      }
    }
  } else {
    const head = Math.max(4, Math.ceil(limit * 0.7));
    const tail = Math.max(2, limit - head);
    for (const index of important.slice(0, head)) keep.add(index);
    for (const index of important.slice(-tail)) keep.add(index);
    for (const index of [...keep]) {
      if (keep.size >= limit) break;
      if (index > 0) keep.add(index - 1);
      if (keep.size >= limit) break;
      if (index + 1 < body.length) keep.add(index + 1);
    }
  }

  let gap = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (keep.has(i)) {
      if (gap > 0) {
        lines.push(`  … truncated (${gap} more lines) · Ctrl+O to expand`);
        gap = 0;
      }
      lines.push(formatDiffBodyLine(body[i] ?? ""));
    } else {
      gap += 1;
    }
  }
  if (gap > 0) lines.push(`  … truncated (${gap} more lines) · Ctrl+O to expand`);
}

function formatDiffBodyLine(line: string): string {
  return `  ▎ ${line}`;
}

function discoverySubject(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return tool;
  if (tool === "search") return `${String(input.query ?? input.pattern ?? "query")}${input.path ? ` · ${input.path}` : ""}`;
  if (tool === "find") return `${String(input.pattern ?? "paths")}${input.root ? ` · ${input.root}` : ""}`;
  if (tool === "git") return formatGitToolRequest(input);
  return String(input.path ?? input.root ?? ".");
}

function formatGitToolRequest(input: Record<string, unknown>): string {
  const parts = [`git ${String(input.operation ?? "status")}`];
  if (input.ref !== undefined) parts.push(`ref ${String(input.ref)}`);
  if (input.maxCount !== undefined) parts.push(`maxCount ${String(input.maxCount)}`);
  return parts.join(" · ");
}

function gitFailureMessage(output: Record<string, unknown> | undefined): string | undefined {
  if (typeof output?.message === "string" && output.message.trim()) return output.message.trim();
  return undefined;
}

function gitFailureCommand(output: Record<string, unknown> | undefined): string | undefined {
  const details = record(output?.details);
  if (typeof details?.command === "string" && details.command.trim()) return details.command.trim();
  if (typeof output?.command === "string" && output.command.trim()) return output.command.trim();
  return undefined;
}

function discoveryResult(tool: string, output: Record<string, unknown> | undefined): string | undefined {
  if (!output) return undefined;
  if (tool === "read") {
    if (typeof output.totalLines === "number" && typeof output.returnedLines === "number") {
      const range = Number(output.startLine) > 0
        ? ` · ${String(output.startLine)}–${String(output.endLine)}`
        : "";
      return `${output.returnedLines}/${output.totalLines} lines${range}${output.truncated ? " · truncated" : ""}`;
    }
    return typeof output.content === "string" ? `${normalizedLines(output.content).length} lines` : undefined;
  }
  if (tool === "tree") return output.entryCount === undefined ? undefined : `${output.entryCount} entries${output.truncated ? " · truncated" : ""}`;
  if (tool === "list") return Array.isArray(output.entries) ? `${output.entries.length} entries${output.truncated ? " · truncated" : ""}` : undefined;
  if (tool === "find") return Array.isArray(output.entries) ? `${output.entries.length} paths${output.truncated ? " · truncated" : ""}` : undefined;
  if (tool === "search") return Array.isArray(output.matches) ? `${output.matches.length} matches${output.truncated ? " · truncated" : ""}` : undefined;
  if (tool === "git") {
    const stream = typeof output.stdout === "string"
      ? output.stdout
      : typeof output.output === "string"
        ? output.output
        : undefined;
    return stream === undefined ? undefined : `${normalizedLines(stream).filter(Boolean).length} lines`;
  }
  return undefined;
}

function diffStats(diff: string): { additions: number; removals: number } {
  const lines = normalizedLines(diff);
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removals: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  };
}

function lastNonEmpty(value: string): string {
  const lines = normalizedLines(value).filter((line) => line.trim());
  return lines.at(-1) ?? "";
}

/** Append up to `limit` trailing process-output lines under a collapsed shell/script/verify card. */
function appendProcessTail(lines: string[], streamLines: readonly string[], limit: number): void {
  if (streamLines.length === 0 || limit <= 0) return;
  const visible = Math.min(limit, streamLines.length);
  for (const line of streamLines.slice(-visible)) {
    lines.push(`  ${oneLine(line, 110)}`);
  }
}

function tailLines(value: string, limit: number): string[] {
  return normalizedLines(value).slice(-limit);
}

function normalizedLines(value: string): string[] {
  return value.replace(/\r/g, "").split("\n").filter((line, index, all) => line || index < all.length - 1);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function processPayload(output: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!output) return undefined;
  const details = record(output.details);
  if (
    details
    && ["exitCode", "timedOut", "stdout", "stderr", "workspaceChange"].some((key) => key in details)
  ) {
    return details;
  }
  return output;
}

function shellArg(value: unknown): string {
  const text = String(value);
  return /[\s"']/u.test(text) ? JSON.stringify(text) : text;
}

function oneLine(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}
