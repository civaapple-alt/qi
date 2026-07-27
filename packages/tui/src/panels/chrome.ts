import { truncateToWidth, visibleWidth } from "../layout.js";
import { theme } from "../theme/index.js";

export function panelRule(width: number): string {
  return theme.fg("primary", "─".repeat(Math.max(8, width)));
}

export function panelHeader(title: string, hints: string, width: number): string[] {
  const left = theme.boldFg("primary", ` ${title} `);
  const right = theme.fg("textMuted", hints);
  const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return [
    panelRule(width),
    truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width, ""),
  ];
}

export function panelFooter(width: number, info?: string): string[] {
  const lines = [panelRule(width)];
  if (info) lines.unshift(truncateToWidth(theme.fg("textMuted", ` ${info}`), width, ""));
  return lines;
}

export function pointer(selected: boolean): string {
  return selected ? theme.fg("primary", "❯ ") : "  ";
}

export function currentMark(isCurrent: boolean): string {
  return isCurrent ? theme.fg("primary", " ← current") : "";
}
