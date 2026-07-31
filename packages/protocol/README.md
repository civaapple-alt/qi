# `@civaapple/qi-protocol`

Durable IDs and Session event schemas shared by every Qi runtime component.

## Purpose

This package defines the language of durable truth: branded identifiers, the `SessionEvent` union, and strict
runtime parsers. Producers and consumers must agree here before a new fact can enter the Session stream.

## Non-goals

- It does not decide whether a transition is legal; `@civaapple/qi-agent/kernel` owns that policy.
- It does not persist, project, transport, or execute events.
- It does not expose provider-specific model payloads as Session truth.

## Core model

`SessionId`, `RunId`, `StepId`, `ActionId`, `TaskId`, `PlanId`, `PlanItemId`, `WorkPlanId`, `WorkItemId`,
`QuestionId`, and related identifiers
carry distinct prefixes. Every durable event has a discriminated `type`, identity links, actor metadata, sequence,
and timestamp. Mode, Plan revision/review, and control Question events are first-class Session facts
([ADR 0011](../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)). Read-only Workspace mounts use
`workspace.mount.added` / `workspace.mount.removed` /
`workspace.sensitive_path.granted` / `workspace.sensitive_path.revoked`
([ADR 0015](../../design/decisions.md#adr-0015-separate-project-policy-from-session-mount-facts)). `parseSessionEvent()` is the runtime boundary
for untrusted serialized input.

## Behavioral invariants

- Event variants are explicit and compatibility-sensitive; failure meanings are never hidden in free-form text.
- Entity identity cannot be reassigned across Session, Run, Step, or Action boundaries.
- IDs of different domain kinds are not interchangeable.
- New events must remain replayable without requiring current process state.
- `context.compiled.blockStats`, when present, carries only bounded per-kind included/omitted count and estimated
  token aggregates. Block payloads, sources, and retention reasons remain outside Session truth.
- `context.compacted` identifies the archived source exchange and token reduction without deleting its events.
- `safety.redaction.applied` records only boundary, scope, category, and count; secret values are forbidden from
  the audit fact itself.
- ProcessTask start, stop request, exit, and lost ownership are explicit facts; transient stdout/stderr is not a
  Session event and cannot serve as settlement evidence.
- `plan.revision.recorded` without `format` replays as `legacy_items`; `formal_markdown` revisions carry the
  complete document and do not require items.
- `run.triggered` may freeze `mode` and a Plan binding. Formal Plan bindings omit `planItemId`; legacy bindings
  retain it.
- `run.triggered.content` optionally records ordered `RunInputPart` text/image metadata. Images contain only
  source, dimensions, byte counts, media types, and original/prepared `artifact://` references; binary bytes and
  provider data URLs are forbidden. Older events without `content` remain text-only through `input`.
- `work.plan.updated` records implementation navigation independently from Formal Plan review and completion
  evidence.
- `run.question.*` settles a blocking Question inside one Run and remains distinct from between-Run
  `control.question.*`.
- `step.completed.finishReason = handoff` explicitly marks a budget continuation summary. Older Sessions without
  this additive value keep their prior history behavior.
- `action.freshness.rebased` records the original and effective whole-file digests when the Loop safely chains a
  same-Step `edit` after a completed edit; it must precede authority and executor entry.
- New Memory facts use the structured `MemoryScope` union. `memory.user.asserted` records an explicit human
  source and `memory.activation.changed` records `relevant` versus user-only `always`; legacy string scopes
  remain replayable but isolated.

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
[ADR 0014](../../design/decisions.md#adr-0014-version-pre-stable-persistence-boundaries-explicitly).

## Verification

`tests/slice0.test.mjs` is the primary lifecycle and replay evidence. Provider protocol behavior is separately
covered by `tests/openai-responses.test.mjs`.

## Further reading

- [Event model](docs/event-model.md)
- [Compatibility policy](docs/compatibility.md)
- [Global Session design](../../design/system-design.md#3-session-lifecycle-and-durable-truth)
