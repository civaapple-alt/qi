# `@civaapple/qi-protocol`

Durable IDs and Session event schemas shared by every Qi runtime component.

## Purpose

This package defines the language of durable truth: branded identifiers, the `SessionEvent` union, and strict
runtime parsers. Producers and consumers must agree here before a new fact can enter the Session stream.

## Non-goals

- It does not decide whether a transition is legal; `@civaapple/qi-kernel` owns that policy.
- It does not persist, project, transport, or execute events.
- It does not expose provider-specific model payloads as Session truth.

## Core model

`SessionId`, `RunId`, `StepId`, `ActionId`, `TaskId`, `PlanId`, `PlanItemId`, `QuestionId`, and related identifiers
carry distinct prefixes. Every durable event has a discriminated `type`, identity links, actor metadata, sequence,
and timestamp. Mode, Plan revision/review, and control Question events are first-class Session facts
([ADR 0011](../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)). Read-only Workspace mounts use
`workspace.mount.added` / `workspace.mount.removed`
([ADR 0015](../../design/decisions.md#adr-0015-separate-project-policy-from-session-mount-facts)). `parseSessionEvent()` is the runtime boundary
for untrusted serialized input.

## Behavioral invariants

- Event variants are explicit and compatibility-sensitive; failure meanings are never hidden in free-form text.
- Entity identity cannot be reassigned across Session, Run, Step, or Action boundaries.
- IDs of different domain kinds are not interchangeable.
- New events must remain replayable without requiring current process state.
- `context.compacted` identifies the archived source exchange and token reduction without deleting its events.
- `safety.redaction.applied` records only boundary, scope, category, and count; secret values are forbidden from
  the audit fact itself.
- ProcessTask start, stop request, exit, and lost ownership are explicit facts; transient stdout/stderr is not a
  Session event and cannot serve as settlement evidence.
- `run.triggered` may freeze `mode` and an optional Plan-item binding; legacy events without `mode` replay as
  Agent.
- `step.completed.finishReason = handoff` explicitly marks a budget continuation summary. Older Sessions without
  this additive value keep their prior history behavior.
- `action.freshness.rebased` records the original and effective whole-file digests when the Loop safely chains a
  same-Step `edit` after a completed edit; it must precede authority and executor entry.

## Failure semantics

Invalid IDs or event shapes fail before reaching storage or projection. Domain-invalid but schema-valid event
sequences are rejected by the Kernel.

## Install and minimal use

```sh
npm install @civaapple/qi-protocol
```

```ts
import { createId } from "@civaapple/qi-protocol";

const sessionId = createId("ses");
```

## Public API

See `src/ids.ts` for ID schemas and `src/events.ts` for `SessionEventSchema`, `SessionEvent`, and
`parseSessionEvent()`.

## Change guide

Changing an event requires synchronized updates to the protocol schema, Kernel projection, persistence and
stream compatibility tests, and the owning package documentation. Prefer additive variants and optional fields;
there is not yet a formal mixed-version event envelope, so incompatible changes require the generation,
preflight, atomic migration, replay, and release gates in
[ADR 0014](../../design/decisions.md#adr-0014-preserve-session-compatibility-through-explicit-migrations).

## Verification

`tests/slice0.test.mjs` is the primary lifecycle and replay evidence. Provider protocol behavior is separately
covered by `tests/openai-responses.test.mjs`.

## Further reading

- [Event model](docs/event-model.md)
- [Compatibility policy](docs/compatibility.md)
- [Global Session design](../../design/system-design.md#3-session-lifecycle-and-durable-truth)
