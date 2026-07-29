const DISCOVERY_TOOLS = new Set(["read", "list", "tree", "find", "search", "git"]);

export interface GroupableTimelineAction {
  readonly actionId: string;
  readonly toolName: string;
  readonly effect: string;
  readonly status: string;
}

export type TimelineActionGroup<T extends GroupableTimelineAction> =
  | { readonly kind: "action"; readonly action: T }
  | { readonly kind: "discovery"; readonly actions: readonly T[]; readonly key: string };

export function isReadOnlyDiscovery(action: GroupableTimelineAction): boolean {
  return action.effect === "read" && DISCOVERY_TOOLS.has(action.toolName);
}

/** Group only consecutive discovery Actions; chronology and every Action remain recoverable. */
export function groupTimelineActions<T extends GroupableTimelineAction>(
  actions: readonly T[],
): TimelineActionGroup<T>[] {
  const groups: TimelineActionGroup<T>[] = [];
  let pending: T[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    if (pending.length === 1) groups.push({ kind: "action", action: pending[0]! });
    else groups.push({
      kind: "discovery",
      actions: [...pending],
      key: `activity:${pending[0]!.actionId}:${pending.at(-1)!.actionId}`,
    });
    pending = [];
  };
  for (const action of actions) {
    if (isReadOnlyDiscovery(action)) pending.push(action);
    else {
      flush();
      groups.push({ kind: "action", action });
    }
  }
  flush();
  return groups;
}

export function discoveryGroupExceptional(
  actions: readonly GroupableTimelineAction[],
): boolean {
  return actions.some((action) =>
    action.status === "failed"
    || action.status === "denied"
    || action.status === "cancelled"
    || action.status === "indeterminate"
  );
}

