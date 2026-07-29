import type { TimelineDensity, TimelineItem } from "./types.js";

export interface TimelineRenderContext {
  readonly density: TimelineDensity;
  readonly expanded: boolean;
}

type ItemOfKind<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;
type TimelineRenderer<K extends TimelineItem["kind"]> = (
  item: ItemOfKind<K>,
  context: TimelineRenderContext,
) => readonly string[];
type ErasedTimelineRenderer = (
  item: TimelineItem,
  context: TimelineRenderContext,
) => readonly string[];

/**
 * Internal registry keeps item policy separate from terminal formatting.
 * Renderers stay pure: no EventStore, focus, execution, or provisional ownership.
 */
export class TimelineRendererRegistry {
  readonly #renderers = new Map<TimelineItem["kind"], ErasedTimelineRenderer>();

  register<K extends TimelineItem["kind"]>(kind: K, renderer: TimelineRenderer<K>): this {
    this.#renderers.set(kind, renderer as unknown as ErasedTimelineRenderer);
    return this;
  }

  render(item: TimelineItem, context: TimelineRenderContext): string[] {
    const renderer = this.#renderers.get(item.kind);
    if (!renderer) throw new Error(`No timeline renderer registered for ${item.kind}`);
    return [...renderer(item, context)];
  }
}

export function createTimelineRendererRegistry(): TimelineRendererRegistry {
  return new TimelineRendererRegistry()
    .register("activity-group", (item, context) => [
      `${item.glyph} ${item.label}${context.expanded ? "" : " · Ctrl+O"}`,
    ]);
}
