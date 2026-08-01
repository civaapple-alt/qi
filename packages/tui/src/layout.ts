import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Pad plain or ANSI text to a display-column width. */
export function padToDisplayWidth(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return padding > 0 ? `${text}${" ".repeat(padding)}` : text;
}

/** Left/right split that always keeps the right side when possible (mode, etc.). */
export function splitKeepRight(left: string, right: string, width: number, gap = 1): string {
  const usable = Math.max(1, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= usable) return truncateToWidth(right, usable, "…");
  const leftBudget = Math.max(0, usable - rightWidth - gap);
  const clippedLeft = leftBudget === 0 ? "" : truncateToWidth(left, leftBudget, "…");
  const spaces = Math.max(gap, usable - visibleWidth(clippedLeft) - rightWidth);
  return `${clippedLeft}${" ".repeat(spaces)}${right}`;
}

/** Shorten a filesystem path for footer display. */
export function shortenPath(path: string, maxSegments = 3): string {
  if (!path) return path;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  let work = path;
  if (home && (path === home || path.startsWith(`${home}\\`) || path.startsWith(`${home}/`))) {
    work = `~${path.slice(home.length).replaceAll("\\", "/")}`;
  } else {
    work = path.replaceAll("\\", "/");
  }
  const segments = work.split("/").filter(Boolean);
  if (segments.length <= maxSegments) return work.startsWith("~") ? work : work;
  const prefix = work.startsWith("~") ? "~/" : "…/";
  return `${prefix}${segments.slice(-maxSegments).join("/")}`;
}

/** Wrap plain text to a display-column budget, breaking mid-word when needed (CJK). */
export function wrapPlain(text: string, width: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const budget = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  for (const character of Array.from(normalized)) {
    const next = `${current}${character}`;
    if (current && visibleWidth(next) > budget) {
      lines.push(current.trimEnd());
      current = character === " " ? "" : character;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [""];
}

/** Wrap a multi-line description; blank source lines become blank output rows. */
export function wrapPlainLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    lines.push(...wrapPlain(paragraph, width));
  }
  return lines.length > 0 ? lines : [""];
}

export { truncateToWidth, visibleWidth };
