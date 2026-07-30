import type { RunView } from "@civaapple/qi-agent/kernel";

const PARK_DETAIL_MAX = 2_000;

/** Actions whose settlement is unknown — used for park detail and handoff enrichment. */
export function indeterminateActions(run: RunView) {
  return Object.values(run.actions).filter((action) => action.status === "indeterminate");
}

/**
 * Durable `run.parked.detail` for indeterminate-effect: include tool name(s) and
 * Action terminal reason so operators are not left with a generic settlement phrase.
 */
export function formatIndeterminateParkDetail(
  run: RunView,
  fallback = "Tool settlement could not be confirmed",
): string {
  const actions = indeterminateActions(run);
  if (actions.length === 0) return fallback;
  const parts = actions.map((action) => {
    const reason = action.terminalDetail?.trim();
    return reason ? `${action.toolName}: ${reason}` : `${action.toolName}: settlement unconfirmed`;
  });
  const suffix = " — do not auto-retry; inspect evidence first";
  const joined = parts.join("; ");
  const budget = Math.max(32, PARK_DETAIL_MAX - suffix.length);
  const body = joined.length <= budget ? joined : `${joined.slice(0, budget - 1)}…`;
  return `${body}${suffix}`;
}
