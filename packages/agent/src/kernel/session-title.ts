/** Matches `session.created` title maxLength; list UIs typically show far less. */
export const SESSION_TITLE_MAX_CHARS = 72;

/** Surface placeholders written before the first user message exists. */
const BOOTSTRAP_SESSION_TITLES = new Set(["Qi TUI"]);

export function isBootstrapSessionTitle(title: string | undefined): boolean {
  return title === undefined || title.trim() === "" || BOOTSTRAP_SESSION_TITLES.has(title);
}

/**
 * Build a Session list title from the first user message: first line only,
 * collapsed whitespace, truncated with an ellipsis when over `maxChars`.
 */
export function sessionTitleFromUserInput(
  input: string,
  maxChars = SESSION_TITLE_MAX_CHARS,
): string {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer");
  }
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maxChars - 1))}…`;
}
