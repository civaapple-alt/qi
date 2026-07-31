import { ToolFailure } from "@civaapple/qi-agent/tools";

export interface EditHunk {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
}

export interface AppliedEditsResult {
  readonly content: string;
  readonly replacements: number;
  readonly usedFuzzyMatch: boolean;
}

interface LineSpan {
  start: number;
  end: number;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

export function detectLineEnding(content: string): "\r\n" | "\n" | "\r" {
  const match = /\r\n|\n|\r/.exec(content);
  return (match?.[0] as "\r\n" | "\n" | "\r" | undefined) ?? "\n";
}

export function normalizeToLf(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n" | "\r"): string {
  if (ending === "\n") return text;
  return text.replaceAll("\n", ending);
}

/** Progressive fuzzy normalization: trailing whitespace, NFKC, quotes, dashes, exotic spaces. */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Normalize legacy `{ oldText, newText, replaceAll? }` into canonical `edits[]`.
 * Canonical inputs pass through unchanged.
 */
export function prepareEditInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const args = { ...(raw as Record<string, unknown>) };
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // leave string for schema validation to reject
    }
  }
  const oldText = args.oldText;
  const newText = args.newText;
  if (typeof oldText !== "string" || typeof newText !== "string") return args;
  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  const hunk: Record<string, unknown> = { oldText, newText };
  if (typeof args.replaceAll === "boolean") hunk.replaceAll = args.replaceAll;
  edits.push(hunk);
  const { oldText: _o, newText: _n, replaceAll: _r, ...rest } = args;
  return { ...rest, edits };
}

/**
 * Apply one or more replacements against the original file bytes.
 * Matching uses LF-normalized exact search, then a limited fuzzy ladder.
 */
export function applyEditsToFileContent(rawContent: string, edits: readonly EditHunk[]): AppliedEditsResult {
  if (edits.length === 0) {
    throw new ToolFailure("TOOL_INPUT", "edits must contain at least one replacement");
  }
  const replaceAllRequested = edits.some((edit) => edit.replaceAll === true);
  if (replaceAllRequested && edits.length !== 1) {
    throw new ToolFailure(
      "TOOL_INPUT",
      "replaceAll is allowed only when edits contains exactly one hunk",
    );
  }

  const { bom, text } = stripBom(rawContent);
  const ending = detectLineEnding(text);
  const normalizedContent = normalizeToLf(text);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
    replaceAll: edit.replaceAll === true,
  }));

  for (let i = 0; i < normalizedEdits.length; i += 1) {
    if (normalizedEdits[i]?.oldText.length === 0) {
      throw new ToolFailure(
        "TOOL_INPUT",
        edits.length === 1 ? "oldText must not be empty" : `edits[${i}].oldText must not be empty`,
      );
    }
  }

  if (edits.length === 1 && normalizedEdits[0]?.replaceAll) {
    return applyReplaceAll(bom, ending, normalizedContent, normalizedEdits[0]!);
  }

  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBase = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i += 1) {
    const edit = normalizedEdits[i]!;
    const matchResult = fuzzyFindText(replacementBase, edit.oldText);
    if (!matchResult.found) {
      throw new ToolFailure(
        "EDIT_TARGET_NOT_FOUND",
        edits.length === 1
          ? "oldText does not occur in the current file; reread the file and retry edit with a current unique fragment"
          : `edits[${i}].oldText does not occur in the current file; reread and retry with a current unique fragment`,
      );
    }
    const occurrences = countOccurrences(replacementBase, edit.oldText);
    if (occurrences > 1) {
      throw new ToolFailure(
        "EDIT_TARGET_AMBIGUOUS",
        edits.length === 1
          ? `oldText occurs ${occurrences} times; provide a larger unique fragment or set replaceAll`
          : `edits[${i}].oldText occurs ${occurrences} times; provide a larger unique fragment or merge into one replaceAll hunk`,
      );
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i += 1) {
    const previous = matchedEdits[i - 1]!;
    const current = matchedEdits[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new ToolFailure(
        "EDIT_TARGETS_OVERLAP",
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap; merge them into one edit or target disjoint regions`,
      );
    }
  }

  const newNormalized = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBase, matchedEdits)
    : applyReplacements(replacementBase, matchedEdits);

  if (newNormalized === normalizedContent) {
    throw new ToolFailure(
      "NO_CHANGE",
      edits.length === 1
        ? "oldText and newText are identical after line-ending reconciliation"
        : "the replacements produced identical content",
    );
  }

  return {
    content: bom + restoreLineEndings(newNormalized, ending),
    replacements: matchedEdits.length,
    usedFuzzyMatch,
  };
}

function applyReplaceAll(
  bom: string,
  ending: "\r\n" | "\n" | "\r",
  normalizedContent: string,
  edit: { oldText: string; newText: string },
): AppliedEditsResult {
  const exactCount = countExactOccurrences(normalizedContent, edit.oldText);
  if (exactCount > 0) {
    if (edit.oldText === edit.newText) {
      throw new ToolFailure("NO_CHANGE", "oldText and newText are identical after line-ending reconciliation");
    }
    const content = normalizedContent.split(edit.oldText).join(edit.newText);
    return {
      content: bom + restoreLineEndings(content, ending),
      replacements: exactCount,
      usedFuzzyMatch: false,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
  const fuzzyOld = normalizeForFuzzyMatch(edit.oldText);
  const fuzzyCount = countExactOccurrences(fuzzyContent, fuzzyOld);
  if (fuzzyCount === 0) {
    throw new ToolFailure(
      "EDIT_TARGET_NOT_FOUND",
      "oldText does not occur in the current file; reread the file and retry edit with a current unique fragment",
    );
  }
  const replacements: TextReplacement[] = [];
  let offset = 0;
  while (true) {
    const index = fuzzyContent.indexOf(fuzzyOld, offset);
    if (index < 0) break;
    replacements.push({ matchIndex: index, matchLength: fuzzyOld.length, newText: edit.newText });
    offset = index + fuzzyOld.length;
  }
  const newNormalized = applyReplacementsPreservingUnchangedLines(normalizedContent, fuzzyContent, replacements);
  if (newNormalized === normalizedContent) {
    throw new ToolFailure("NO_CHANGE", "oldText and newText are identical after line-ending reconciliation");
  }
  return {
    content: bom + restoreLineEndings(newNormalized, ending),
    replacements: fuzzyCount,
    usedFuzzyMatch: true,
  };
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
    };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
  };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return countExactOccurrences(fuzzyContent, fuzzyOldText);
}

function countExactOccurrences(content: string, fragment: string): number {
  if (fragment.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(fragment, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + fragment.length;
  }
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new ToolFailure("EDIT_TARGET_NOT_FOUND", "Replacement range is outside the base content");
  }
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) {
    endLine += 1;
  }
  if (endLine >= lines.length) {
    throw new ToolFailure("EDIT_TARGET_NOT_FOUND", "Replacement range is outside the base content");
  }
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: readonly TextReplacement[], offset = 0): string {
  let result = content;
  const ordered = [...replacements].sort((a, b) => b.matchIndex - a.matchIndex);
  for (const replacement of ordered) {
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.slice(0, matchIndex) + replacement.newText + result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: readonly TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new ToolFailure(
      "EDIT_TARGET_NOT_FOUND",
      "Cannot preserve unchanged lines because fuzzy normalization changed the line count",
    );
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine]!.start;
    const groupEndOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}
