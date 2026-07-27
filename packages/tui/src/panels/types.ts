import type { Component, Focusable } from "@earendil-works/pi-tui";

export interface PanelCloseReason {
  readonly kind: "dismiss" | "select" | "action";
  readonly value?: string;
}

export interface PanelComponent extends Component, Focusable {
  readonly title: string;
}

export interface PanelItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly current?: boolean;
  readonly disabled?: boolean;
}

export type PanelFactory = () => PanelComponent;
