# `@civaapple/qi-agent/kernel`

The deterministic state machine that validates and projects Qi's append-only Session history.

## Purpose

The Kernel turns a validated event sequence into `SessionView`. It defines legal lifecycle transitions and the
minimal `EventStore` port used by loops, evaluators, streams, and durable adapters.

## Non-goals

- It never calls models, tools, external systems, or user interfaces.
- It does not authorize actions or infer missing events.
- A projection is not a second source of truth and is never mutated directly.

## Core model

`applySessionEvent()` applies one fact to a projection; `replaySession()` reconstructs the same view from the
complete history. Runs contain Steps and Actions, while goals, evidence, evaluations, memory, control receipts,
Session mode, Plan revisions/reviews, and pending control Questions remain related first-class views.
ProcessTasks are Session-scoped views linked back to their originating Run/Step/Action, so their lifetime may
outlast a completed Run without making that Run unsettled.

## Behavioral invariants

- A Session stream cannot be aliased to a different Session ID.
- Authority and action start are durable before execution.
- Action terminal meanings remain distinct, including indeterminate settlement.
- A Run cannot terminate while an Action settlement is unknown.
- Verified completion rejects missing or untrusted evidence.
- Terminal Run outcomes are mutually exclusive.
- Value-free safety audit events replay deterministically without becoming mutable domain state.
- Context compaction can reference only a completed source Step, must reduce estimated cost, and remains visible
  on the current Step projection.
- A ProcessTask can start only from a running authorized Action; stop, exit, and lost ownership are distinct,
  validated transitions.
- Mode changes are rejected while a top-level Run is active or a Plan review / control Question is pending; Ask
  and Plan Runs deny tools/effects outside their mode allowlists; Plan-bound Agent Runs require an accepted
  revision and bind at most one Plan item.

## Failure semantics

Illegal transitions throw `StateTransitionError`. Stale optimistic writes throw `ConcurrencyError`. The Kernel
does not repair or skip invalid history; recovery must add explicit events through an authorized supervisor.

## Install and minimal use

```sh
npm install @civaapple/qi-agent/kernel @civaapple/qi-protocol
```

```ts
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { createId } from "@civaapple/qi-protocol";

const stream = new InMemoryEventStore().read(createId("ses"));
```

## Public API

The stable surface is `applySessionEvent()`, `replaySession()`, projection view types, `EventStore`,
`InMemoryEventStore`, domain errors, and the `KERNEL_ASK_MODE_TOOLS` /
`KERNEL_PLAN_MODE_EXTRA_TOOLS` hard-gate allowlists. The allowlists are exported so cross-package verification can
prove that Kernel replay and capability policy accept the same Ask/Plan tool names; they do not grant authority.
`KERNEL_PLAN_MODE_EXTRA_TOOLS` includes Plan-advertised extras (`plan_document`, `ask_question`, `update_plan`,
`delegate`); Kernel still denies `ask_question` / `update_plan` in Ask and keeps `plan_document` Plan-only.

## Change guide

Update event schema first, then transition rules and replay tests. Any new terminal or recovery state must be
handled exhaustively in all projections and downstream control surfaces.

## Verification

Use `tests/slice0.test.mjs` for transition invariants and `tests/sqlite-store.test.mjs` for persistence parity.

## Further reading

- [Projection model](docs/projection-model.md)
- [State machine and recovery](docs/state-machine.md)
- [Protocol event model](../protocol/docs/event-model.md)
