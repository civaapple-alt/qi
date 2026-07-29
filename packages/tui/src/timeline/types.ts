export type TimelineDensity = "compact" | "standard" | "diagnostic";

export type TimelineImportance = "primary" | "secondary" | "diagnostic" | "attention";
export type TimelineLifecycle = "provisional" | "active" | "settled" | "waiting";

interface TimelineItemBase {
  readonly key: string;
  readonly importance: TimelineImportance;
  readonly lifecycle: TimelineLifecycle;
  readonly expandable: boolean;
  readonly fingerprint: string;
}

export type TimelineItem =
  | (TimelineItemBase & { readonly kind: "conversation"; readonly role: "user" | "agent" })
  | (TimelineItemBase & { readonly kind: "thinking"; readonly stepId: string })
  | (TimelineItemBase & {
      readonly kind: "activity-group";
      readonly actionIds: readonly string[];
      readonly glyph: string;
      readonly label: string;
    })
  | (TimelineItemBase & { readonly kind: "action"; readonly actionId: string })
  | (TimelineItemBase & { readonly kind: "plan"; readonly planId: string })
  | (TimelineItemBase & { readonly kind: "delegation"; readonly delegationIds: readonly string[] })
  | (TimelineItemBase & { readonly kind: "attention"; readonly subject: string })
  | (TimelineItemBase & { readonly kind: "handoff"; readonly runId: string });
