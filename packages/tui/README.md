# `@civaapple/qi-tui`

Version **0.7.0**. Package maturity: **internal public-package preview**.

Reusable Qi-specific terminal presentation and control components built on
`@earendil-works/pi-tui`.

## Purpose

- Project committed `SessionEvent` and `SessionView` facts into terminal-friendly transcripts and status views.
- Render bounded Markdown and Action cards without turning provisional activity into settlement.
- Wrap wide Markdown table cells (or stack fields on narrow terminals) so later columns are not clipped, and
  keep the latest three display-wrapped provisional model text/reasoning/tool lines visible in the Working strip.
- Render committed model reasoning as a distinct three-line Thinking block, and render an accepted Formal Plan
  as a 200-line transcript preview with its immutable local path instead of treating it as pasted input.
- Keep bounded file Diff previews for completed mutations in the active Run's retained eight-Step window, and
  expose bounded process failure evidence instead of hiding it inside the ToolFailure envelope.
- Provide reusable composer, follow-up queue, selection/form/scroll panels, themes, and layout helpers.
- Keep Qi-specific control vocabulary separate from CLI startup, credentials, persistence, and process ownership.

## Non-goals

- This is not a general replacement for `@earendil-works/pi-tui`.
- It does not create Sessions, call models, execute Tools, grant capabilities, or own application lifecycle.
- `TuiPresenter` projects supplied facts; it is not a second Runtime or source of Session truth.
- Provider login, configuration files, CLI arguments, and the interactive application shell remain in
  `@civaapple/qi`.

## Quick start

```sh
npm install @civaapple/qi-tui
```

```ts
import {
  ListPanel,
  TuiPresenter,
  renderMarkdown,
  statusGlyph,
} from "@civaapple/qi-tui";

const presenter = new TuiPresenter({
  workspaceRoot: process.cwd(),
  dataRoot: ".qi",
  provider: "scripted",
  model: "example",
  capabilities: [],
  contextWindowTokens: 128_000,
  contextBudgetTokens: 112_000,
  outputReserveTokens: 16_000,
  historyBudgetTokens: 16_000,
  maxSteps: 20,
  maxActionsPerStep: 6,
});

console.log(renderMarkdown("## Qi", 80));
console.log(statusGlyph("denied"));
```

Application authors provide committed events and projections to `TuiPresenter.update()`. Components that
implement the `pi-tui` `Component`/`Focusable` contracts can be mounted in an existing terminal application.

## Public API

- `TuiPresenter` and projection/render helpers;
- `ComposerComponent`, `FollowUpQueue`, and `FollowUpsComponent`;
- `ListPanel`, `MultiSelectPanel`, `FormPanel` (text, secret, and terminal-dropdown fields with optional custom
  input), `QuestionPanel`, `ScrollPanel`, `SessionsPanel`, and `PanelHost`;
- Codex-style `update_plan` Todo snapshots in the Action timeline; legacy Plan-item Todo projection remains
  replay-only for legacy plans.
- command parsing/autocomplete and localization helpers;
- Markdown, layout, theme, Action-card, Session-list, and repaint helpers.

The CLI runtime, auth/configuration, project policy, provider setup, tool construction, and process entrypoint
are intentionally absent.

## Change guidance

Keep the package render-only or local-component-state-only. New exports must not write Session facts, enter Tool
executors, load credentials, read policy files, or hide unbounded output. Add component or projection tests and
an isolated TypeScript consumer for every compatibility-sensitive public API change.

## Verification

- `tests/tui-package.test.mjs` exercises the package directly.
- `tests/tui-presentation.test.mjs` covers projections, cards, panels, bounded rendering, and repaint semantics.
- `npm run packages:check` installs the tarball into an empty consumer and typechecks its public imports.

## Further reading

- [ADR 0018](../../design/decisions.md#adr-0018-publish-a-modular-open-source-runtime)
- [TUI application contract](../../apps/cli/README.md)
- [Bounded transcript rendering](../../design/decisions.md#adr-0017-bound-tui-transcript-work)
