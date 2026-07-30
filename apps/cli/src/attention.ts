export type AttentionGate =
  | "run-question"
  | "plan-review"
  | "next-run"
  | "sensitive-path-grant"
  | "path-grant";

export interface AttentionFocusState {
  readonly panelOpen: boolean;
  readonly composerEmpty: boolean;
  readonly followUpEditing: boolean;
}

export function canAutoOpenAttention(state: AttentionFocusState): boolean {
  return !state.panelOpen && state.composerEmpty && !state.followUpEditing;
}

/** Durable gate priority; this function never changes focus or execution state. */
export function highestPriorityAttention(pending: {
  readonly runQuestion: boolean;
  readonly planReview: boolean;
  readonly nextRun: boolean;
  readonly sensitivePathGrant: boolean;
  readonly pathGrant: boolean;
}): AttentionGate | undefined {
  if (pending.runQuestion) return "run-question";
  if (pending.planReview) return "plan-review";
  if (pending.nextRun) return "next-run";
  if (pending.sensitivePathGrant) return "sensitive-path-grant";
  if (pending.pathGrant) return "path-grant";
  return undefined;
}
