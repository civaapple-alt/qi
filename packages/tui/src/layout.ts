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

export { truncateToWidth, visibleWidth };
