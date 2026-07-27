/**
 * Qi semantic palettes. Tokens document where they are consumed so
 * future theme work can stay narrow and accessible.
 */

export interface ColorPalette {
  /** Brand / interactive focus: panel titles, selected rows, mode accent. */
  primary: string;
  /** Secondary highlight: accents that should not compete with primary. */
  accent: string;
  /** Default body text. */
  text: string;
  /** Emphasised text. */
  textStrong: string;
  /** Secondary / dim text: hints, descriptions, footer path. */
  textDim: string;
  /** Faintest text: scroll info, muted metadata. */
  textMuted: string;
  /** Panel and editor borders. */
  border: string;
  /** Focused border for active panels / composer. */
  borderFocus: string;
  /** Success marks and completed states. */
  success: string;
  /** Warnings, parked / waiting attention. */
  warning: string;
  /** Errors, denials, failed settlements. */
  error: string;
  /** Diff additions. */
  diffAdded: string;
  /** Diff removals. */
  diffRemoved: string;
  /** Diff meta / hunk headers. */
  diffMeta: string;
  /** User message role colour. */
  roleUser: string;
  /** User message bar background (256-friendly hex). */
  userMessageBg: string;
  /** Tool pending / running background. */
  toolPendingBg: string;
  /** Tool success background. */
  toolSuccessBg: string;
  /** Tool error background. */
  toolErrorBg: string;
}

/** Qi dark palette — cool teal primary, not the common purple-AI look. */
export const darkColors: ColorPalette = {
  primary: "#3DB8A8",
  accent: "#6B9BD2",
  text: "#E6E6E6",
  textStrong: "#F5F5F5",
  textDim: "#8A8A8A",
  textMuted: "#6A6A6A",
  border: "#555555",
  borderFocus: "#3DB8A8",
  success: "#4EC87E",
  warning: "#D4A017",
  error: "#E05C5C",
  diffAdded: "#4EC87E",
  diffRemoved: "#E05C5C",
  diffMeta: "#8A8A8A",
  roleUser: "#E8C47C",
  userMessageBg: "#2A2A2A",
  toolPendingBg: "#243033",
  toolSuccessBg: "#1F2B24",
  toolErrorBg: "#332222",
};

/** Qi light palette — WCAG AA-ish contrast on white. */
export const lightColors: ColorPalette = {
  primary: "#0F766E",
  accent: "#1D4E89",
  text: "#1A1A1A",
  textStrong: "#111111",
  textDim: "#4A4A4A",
  textMuted: "#5F5F5F",
  border: "#737373",
  borderFocus: "#0F766E",
  success: "#157A3E",
  warning: "#8A5A00",
  error: "#B42318",
  diffAdded: "#157A3E",
  diffRemoved: "#B42318",
  diffMeta: "#5F5F5F",
  roleUser: "#8A5A00",
  userMessageBg: "#F0F0F0",
  toolPendingBg: "#E8F2F1",
  toolSuccessBg: "#E6F4EA",
  toolErrorBg: "#FCE8E6",
};

export type ThemeName = "dark" | "light" | "auto";
