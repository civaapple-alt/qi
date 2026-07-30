# Projection model

`SessionView` is a deterministic fold over committed events:

```text
undefined + SessionCreated -> SessionView
SessionView + SessionEvent -> next SessionView
```

`applySessionEvent()` validates one transition and returns the next view. `replaySession()` applies the same rule
to full history. There is no separate mutation API.

## Why this boundary exists

- Recovery reconstructs behavior from durable facts.
- TUI, Web, evaluation, and supervision observe the same state semantics.
- Invalid histories fail at the earliest deterministic boundary.
- Tests can explain a failure by showing the minimal preceding event sequence.

## Projection rules

- Entity creation precedes updates.
- Parent identity is immutable.
- Lifecycle transitions are monotonic unless an explicit event defines otherwise.
- Terminal outcomes are mutually exclusive.
- Evidence and evaluations retain provenance rather than collapsing to a summary boolean.
- Unknown Action settlement blocks incompatible Run terminal transitions.

## Derived fields

Derived views may cache convenient status or indexes, but the value must be completely determined by prior events.
Never add current time, random selection, network lookup, or provider cache access to projection.

Bootstrap Session titles such as `Qi TUI` are replaced by a truncated first-line form of the first user
`run.triggered` input (72 characters max). Explicit non-bootstrap titles from `session.created` are kept.

## Evidence

`tests/slice0.test.mjs` provides the transition matrix in executable form. `tests/sqlite-store.test.mjs` proves
that restart and durable replay produce the same projection. `tests/session-title.test.mjs` covers bootstrap
title replacement from the first user message and SQLite list projection.
