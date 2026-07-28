import type { ActionStatus } from "@civaapple/qi-agent/kernel";
import { theme } from "./theme/index.js";

export interface ToolCardModel {
  actionId: string;
  toolName: string;
  status: ActionStatus;
  input?: unknown;
  output?: Record<string, unknown>;
  errorCode?: string;
  elapsed?: string;
  resources?: readonly string[];
  liveTail?: { stream: "stdout" | "stderr" | "model"; text: string; droppedLines: number };
}

export interface ToolCardOptions {
  expanded?: boolean;
  outputLines?: number;
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
};

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
    const tail = lastNonEmpty(stream);
    return [`${title}${tail ? ` · ${oneLine(tail, 80)}` : ""}`];
  }
  const lines = [title];

  if (model.status === "running" || model.liveTail?.text) {
    const live = model.liveTail?.text ? lastNonEmpty(model.liveTail.text) : "running…";
    lines.push(`  · ${oneLine(live, 110)}`);
  } else {
    if (exitSummary && model.status !== "completed") lines.push(`  ${exitSummary}`);
    if (!options.expanded && streamLines.length > 0) {
      const hidden = Math.max(0, streamLines.length - 1);
      if (hidden > 0) lines.push(`  … ${hidden} output lines hidden · Ctrl+O to expand`);
      lines.push(`  ${oneLine(streamLines.at(-1) ?? "", 110)}`);
    }
  }

  if (options.expanded) {
    if (workdir && workdir !== ".") lines.push(`  cwd ${workdir}`);
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
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return parts.slice(-2).join("/");
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
  if (options.summaryOnly) return [header(model, subject, result)];
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
  } else if (model.toolName === "git" && typeof output?.output === "string" && output.output.trim()) {
    appendBounded(lines, output.output, options.expanded ? 12 : 6, "output");
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
  return [header(model, command, result), ...(output ? ["  detached as a bounded ProcessTask · /tasks"] : [])];
}

function renderDelegate(model: ToolCardModel, options: ToolCardOptions): string[] {
  const input = record(model.input);
  const output = model.output;
  const subject = oneLine(String(input?.objective ?? "subagent"), 80);
  const result = output
    ? [
      output.accepted === true ? "accepted" : output.accepted === false ? "rejected" : undefined,
      output.delegationId,
      output.summaryRef,
    ].filter(Boolean).join(" · ")
    : model.errorCode;
  if (options.summaryOnly) return [header(model, subject, result)];
  const lines = [header(model, subject, result)];
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
  const title = String(input?.title ?? "Plan");
  const items = Array.isArray(input?.items) ? input.items : [];
  const result = output
    ? `rev ${String(output.revision)} · ${String(output.itemCount)} items`
    : model.errorCode ?? (items.length > 0 ? `${items.length} items` : undefined);
  if (options.summaryOnly) return [header(model, title, result)];
  const lines = [header(model, title, result)];
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

function renderGeneric(model: ToolCardModel, options: ToolCardOptions): string[] {
  const summary = oneLine(JSON.stringify(model.input ?? {}), 100);
  if (options.summaryOnly) return [header(model, summary, model.errorCode)];
  const lines = [header(model, summary, model.errorCode)];
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
  if (tool === "git") return String(input.operation ?? "status");
  return String(input.path ?? input.root ?? ".");
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
  if (tool === "git") return typeof output.output === "string" ? `${normalizedLines(output.output).filter(Boolean).length} lines` : undefined;
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
