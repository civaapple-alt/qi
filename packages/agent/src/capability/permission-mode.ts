/**
 * Product permission mode (ADR-0040). Orthogonal to Session mode (ask|plan|agent).
 * User-facing control for in-lease approval rhythm and the coding lease pack.
 */
export type PermissionMode = "manual" | "yolo" | "auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["manual", "yolo", "auto"];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

export function formatPermissionLabel(mode: PermissionMode): string {
  switch (mode) {
    case "manual":
      return "Manual";
    case "yolo":
      return "YOLO";
    case "auto":
      return "Auto";
  }
}

/** One-line product copy for TUI / CLI help. */
export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case "manual":
      return "Approve non-read actions yourself (Once / Session / Project memory).";
    case "yolo":
      return "Auto-accept in-lease tools; system sandbox enforces hard boundaries.";
    case "auto":
      return "Fully autonomous in-lease work; suppresses tool-form questions.";
  }
}

/**
 * Internal capability flags derived from permission mode (Agent session mode).
 * Session mode still narrows; Ask cannot write even under yolo.
 * Expert/CLI overrides may further restrict but should not silently invent rights beyond this pack
 * unless using legacy capability overrides or `--allow-*`.
 */
export interface PermissionLeasePack {
  readonly write: boolean;
  readonly execute: boolean;
  readonly verify: boolean;
  readonly network: boolean;
  readonly background: boolean;
  readonly delegate: boolean;
  readonly publish: boolean;
  readonly spend: boolean;
}

/** Read-only research baseline (`--safe` or Ask-effective). */
export const SAFE_LEASE_PACK: PermissionLeasePack = {
  write: false,
  execute: false,
  verify: false,
  network: false,
  background: false,
  delegate: false,
  publish: false,
  spend: false,
};

/**
 * Coding pack for Agent under manual/yolo/auto.
 * Publish/spend stay off unless product tools register them and expert policy opens them later.
 */
export const CODING_LEASE_PACK: PermissionLeasePack = {
  write: true,
  execute: true,
  verify: true,
  network: true,
  background: true,
  delegate: true,
  publish: false,
  spend: false,
};

export function leasePackForPermissionMode(
  mode: PermissionMode,
  options: { readonly safe?: boolean } = {},
): PermissionLeasePack {
  if (options.safe) return { ...SAFE_LEASE_PACK };
  // All three modes open the same coding pack; manual only changes approval rhythm.
  return { ...CODING_LEASE_PACK };
}

/** Whether non-read in-lease actions auto-accept without a human prompt. */
export function permissionAutoAcceptsInLease(mode: PermissionMode): boolean {
  return mode === "yolo" || mode === "auto";
}

/** Whether tool-form ask_question should be suppressed (auto). */
export function permissionSuppressesAskQuestion(mode: PermissionMode): boolean {
  return mode === "auto";
}

export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const index = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length] ?? "manual";
}
