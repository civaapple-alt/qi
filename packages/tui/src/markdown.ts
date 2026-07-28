/**
 * Bounded terminal Markdown renderer for Agent replies and Plans.
 * Keeps ANSI-friendly layout without claiming full CommonMark fidelity.
 */

import { truncateToWidth, visibleWidth } from "./layout.js";

export interface MarkdownRenderOptions {
  readonly width?: number;
  readonly expandCodeBlocks?: boolean;
  readonly maxCodeLines?: number;
}

export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): string[] {
  const width = Math.max(40, options.width ?? 100);
  const maxCodeLines = options.maxCodeLines ?? 24;
  const expandCode = options.expandCodeBlocks === true;
  const lines: string[] = [];
  const raw = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    // Models often omit blank lines between headings and tables; split mixed blocks.
    lines.push(...renderMixedBlock(paragraph, width));
    paragraph = [];
  };

  while (index < raw.length) {
    const line = raw[index]!;
    if (/^```/.test(line)) {
      flushParagraph();
      const fence: string[] = [line];
      index += 1;
      while (index < raw.length && !/^```\s*$/.test(raw[index]!)) {
        fence.push(raw[index]!);
        index += 1;
      }
      if (index < raw.length) {
        fence.push(raw[index]!);
        index += 1;
      }
      lines.push(...renderFence(fence, width, maxCodeLines, expandCode));
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }
    // Headings start a new block even when the model skipped a blank line.
    if (/^#{1,6}\s+/.test(line) && paragraph.length > 0) {
      flushParagraph();
    }
    // Table rows after prose (or after a heading already flushed) stay grouped.
    if (isTableLine(line) && paragraph.length > 0 && !paragraph.every(isTableLine)) {
      flushParagraph();
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();

  while (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

/** Split a blank-line-free run into headings, tables, and prose. */
function renderMixedBlock(rows: readonly string[], width: number): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < rows.length) {
    const line = rows[index]!;
    if (/^#{1,6}\s+/.test(line)) {
      out.push(...renderLine(line, width));
      index += 1;
      continue;
    }
    if (isTableLine(line)) {
      const start = index;
      index += 1;
      while (index < rows.length && isTableLine(rows[index]!)) index += 1;
      const tableRows = rows.slice(start, index);
      if (isTable(tableRows)) out.push(...renderTable(tableRows, width));
      else {
        for (const row of tableRows) out.push(...renderLine(row, width));
        out.push("");
      }
      continue;
    }
    const start = index;
    index += 1;
    while (
      index < rows.length &&
      !/^#{1,6}\s+/.test(rows[index]!) &&
      !isTableLine(rows[index]!)
    ) {
      index += 1;
    }
    for (const prose of rows.slice(start, index)) {
      out.push(...renderLine(prose, width));
    }
    out.push("");
  }
  return out;
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^\|?[\s|:-]+$/.test(trimmed) && /---/.test(trimmed)) return true;
  return /^\|.+\|$/.test(trimmed) || /^\|.+\|/.test(trimmed) || /\|.+\|$/.test(trimmed);
}

function isTable(rows: string[]): boolean {
  if (rows.length < 2) return false;
  const looksLikeRow = (line: string) => isTableLine(line) && !/^\|?[\s|:-]+$/.test(line.trim());
  const looksLikeSep = (line: string) => /^\|?[\s|:-]+$/.test(line.trim()) && /---/.test(line);
  const dataOrSep = rows.every((row) => looksLikeRow(row) || looksLikeSep(row));
  if (!dataOrSep) return false;
  return looksLikeSep(rows[1] ?? "") || rows.filter(looksLikeRow).length >= 2;
}

function renderFence(fence: readonly string[], width: number, maxCodeLines: number, expand: boolean): string[] {
  const opener = fence[0] ?? "```";
  const language = opener.replace(/^```/, "").trim() || "code";
  const body = fence.slice(1).filter((line) => !/^```\s*$/.test(line));
  const out = [`┌─ ${language}`];
  const visible = expand || body.length <= maxCodeLines ? body : body.slice(0, maxCodeLines);
  for (const line of visible) {
    out.push(`│ ${truncate(line, width - 2)}`);
  }
  if (!expand && body.length > maxCodeLines) {
    out.push(`│ … ${body.length - maxCodeLines} lines hidden · Ctrl+O to expand`);
  }
  out.push("└─");
  out.push("");
  return out;
}

function renderTable(rows: string[], width: number): string[] {
  const parsed = rows
    .map((row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => inline(cell.trim())))
    .filter((cells) => cells.some((cell) => !/^[-:]+$/.test(cell)));
  if (parsed.length === 0) return rows.map((row) => truncate(row, width));
  const columns = Math.max(...parsed.map((row) => row.length));
  const frameWidth = (3 * columns) + 1;
  const contentBudget = width - frameWidth;
  if (contentBudget < columns * 10) return renderStackedTable(parsed, columns, width);
  const naturalWidths = Array.from({ length: columns }, (_, index) =>
    Math.max(3, ...parsed.map((row) => visibleWidth(row[index] ?? ""))),
  );
  const widths = allocateTableWidths(naturalWidths, contentBudget);
  const out: string[] = [];
  for (const [rowIndex, row] of parsed.entries()) {
    const cells = Array.from({ length: columns }, (_, index) =>
      wrapCell(row[index] ?? "", widths[index]!),
    );
    const height = Math.max(...cells.map((cell) => cell.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const line = cells.map((cell, index) =>
        pad(cell[lineIndex] ?? "", widths[index]!)
      );
      out.push(`│ ${line.join(" │ ")} │`);
    }
    if (rowIndex === 0) {
      out.push(`├─${widths.map((size) => "─".repeat(size)).join("─┼─")}─┤`);
    }
  }
  out.push("");
  return out;
}

function allocateTableWidths(naturalWidths: readonly number[], budget: number): number[] {
  if (naturalWidths.reduce((sum, value) => sum + value, 0) <= budget) return [...naturalWidths];
  const widths = naturalWidths.map(() => 10);
  let remaining = budget - widths.length * 10;
  while (remaining > 0) {
    let selected = -1;
    let largestDeficit = 0;
    for (const [index, natural] of naturalWidths.entries()) {
      const deficit = natural - widths[index]!;
      if (deficit > largestDeficit) {
        selected = index;
        largestDeficit = deficit;
      }
    }
    if (selected < 0) break;
    widths[selected] = widths[selected]! + 1;
    remaining -= 1;
  }
  return widths;
}

function renderStackedTable(parsed: readonly (readonly string[])[], columns: number, width: number): string[] {
  const headers = parsed[0] ?? [];
  const data = parsed.slice(1);
  const out: string[] = [];
  for (const [rowIndex, row] of data.entries()) {
    out.push(`• row ${rowIndex + 1}`);
    for (let column = 0; column < columns; column += 1) {
      const header = headers[column] || `column ${column + 1}`;
      out.push(...wrapCell(`${header}:`, Math.max(1, width - 2)).map((line) => `  ${line}`));
      out.push(...wrapCell(row[column] ?? "", Math.max(1, width - 4)).map((line) => `    ${line}`));
    }
    out.push("");
  }
  return out.length > 0 ? out : parsed.flatMap((row) => wrapCell(row.join(" | "), width));
}

function wrapCell(value: string, width: number): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const lines: string[] = [];
  let current = "";
  for (const character of Array.from(normalized)) {
    const next = `${current}${character}`;
    if (current && visibleWidth(next) > width) {
      lines.push(current.trimEnd());
      current = character === " " ? "" : character;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [""];
}

function renderLine(line: string, width: number): string[] {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1]!.length;
    const text = inline(heading[2] ?? "");
    if (level === 1) return [text, "═".repeat(Math.min(width, Math.max(8, visibleWidth(text)))), ""];
    // h2–h6: show title text with an underline; never leave raw ### hashes in the transcript.
    return [text, "─".repeat(Math.min(width, Math.max(8, visibleWidth(text)))), ""];
  }
  if (/^>\s?/.test(line)) return [`│ ${inline(line.replace(/^>\s?/, ""))}`];
  if (/^[-*+]\s+\[([ xX])\]\s+/.test(line)) {
    const checked = /^[-*+]\s+\[[xX]\]\s+/.test(line);
    return [`${checked ? "☑" : "☐"} ${inline(line.replace(/^[-*+]\s+\[[ xX]\]\s+/, ""))}`];
  }
  if (/^[-*+•]\s+/.test(line)) return [`• ${inline(line.replace(/^[-*+•]\s+/, ""))}`];
  if (/^\d+\.\s+/.test(line)) {
    const match = /^(\d+)\.\s+(.*)$/.exec(line);
    return [`${match?.[1] ?? "1"}. ${inline(match?.[2] ?? "")}`];
  }
  if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
    return ["─".repeat(Math.min(width, 40))];
  }
  return wrap(inline(line), width);
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(^|[^\w])_([^_]+)_($|[^\w])/g, "$1$2$3")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 <$2>");
}

function wrap(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (visibleWidth(next) > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(truncate(current, width));
  return lines;
}

function truncate(text: string, width: number): string {
  return truncateToWidth(text, width, "…");
}

function pad(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return padding > 0 ? `${text}${" ".repeat(padding)}` : text;
}
