# `@civaapple/qi-agent/memory`

Provenance-backed memory claims, retrieval lifecycle, correction, forgetting, attention, and presence.

## Purpose

Memory gives continuity across Sessions without turning all history into permanent truth. Claims move through an
explicit lifecycle and retain evidence links. `ContinuityController` separately governs proactive attention and
presence signals.

## Non-goals

- Memory retrieval is not authority.
- The Agent cannot self-accept sensitive or relational claims.
- Working context and expired claims do not silently become long-lived memory.
- Presence is not simulated emotion or hidden user profiling.

## Core model

`MemoryController` proposes, accepts, disputes, corrects, activates, and forgets claims through the portable
`MemoryIndex` port. Node's `SqliteMemoryIndex` stores lifecycle-aware, rebuildable retrieval projections. Every
durable claim references a real immutable Session event.

## Behavioral invariants

- Long-lived claims have provenance and explicit status.
- Correction and forgetting remove superseded content from retrieval.
- Sensitive and relational candidates require user confirmation.
- Session/Project/User scopes are structured; only explicitly confirmed User claims cross projects.
- Only a user may select `always`; at most four accepted User claims may use it.
- Working and expired claims never re-enter long-lived context.
- Quiet hours and attention budgets govern interruption independently of memory relevance.

## Failure semantics

Missing provenance, invalid promotion, expired claims, and denied attention remain explicit. Forgetting changes
retrieval status without rewriting the original Session history.

## Install and minimal use

```sh
npm install @civaapple/qi-agent/memory
```

```ts
import { MemoryController } from "@civaapple/qi-agent/memory";
import { SqliteMemoryIndex } from "@civaapple/qi-node/storage";

const index = new SqliteMemoryIndex(":memory:");
try {
  const controller = new MemoryController(eventStore, index, sessionId);
  // Controllers write provenance-validated events, then update the derived index.
} finally {
  index.close();
}
```

## Public API

`MemoryController`, `MemoryIndex`, claim/scope types, `ContinuityController`, and attention decision types.
`SqliteMemoryIndex` is exported by `@civaapple/qi-node/storage`.

## Change guide

New memory layers or ranking signals must specify promotion, provenance, correction, expiry, forgetting, and
human control. Do not couple relevance scoring to interruption permission.

## Verification

`tests/memory-continuity.test.mjs` covers cross-Session retrieval, confirmation, provenance, correction,
forgetting, quiet hours, and presence.

## Further reading

- [Memory lifecycle](memory-lifecycle.md)
- [Attention and presence](attention-and-presence.md)
- [Memory design](../../../../design/system-design.md#5-context-models-and-memory)
