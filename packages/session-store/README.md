# `@civaapple/qi-session-store`

SQLite-backed durable storage for append-only Session event streams.

## Purpose

`SqliteEventStore` implements the Kernel `EventStore` port with atomic append, optimistic concurrency, ordered
reads, and restart-safe reconstruction.

## Non-goals

- It does not decide whether domain transitions are valid independently of the Kernel.
- It does not maintain mutable Session snapshots as authoritative data.
- It does not provide generic application database access.

## Core model

Each stream is keyed by Session identity and an expected version. A batch either validates and commits in full
or leaves the stream unchanged. Reading returns the durable order used by Kernel replay.

## Behavioral invariants

- Batch append is atomic.
- Expected-version checks survive process restart.
- Stream key and event Session identity must match.
- Persisted ordering is stable and sufficient to rebuild the same projection.

## Failure semantics

Stale writers receive a concurrency failure; invalid events or identity mismatches roll back the entire batch.
Storage errors are not translated into successful or partial domain transitions.

## Install and minimal use

```sh
npm install @civaapple/qi-session-store
```

```ts
import { SqliteEventStore } from "@civaapple/qi-session-store";

const store = new SqliteEventStore(":memory:");
try {
  console.log(store.listSessions());
} finally {
  store.close();
}
```

## Public API

`SqliteEventStore` and `SqliteEventStoreOptions` are exported from `src/sqlite-event-store.ts`.

## Change guide

Preserve compatibility with `EventStore`. Changes to tables or serialization require restart, atomic rollback,
and replay coverage. Existing databases without format metadata are generation 1. An incompatible writable
change requires the explicit generation, preflight, atomic migration, replay, and release process in
[ADR 0014](../../design/decisions.md#adr-0014-preserve-session-compatibility-through-explicit-migrations); migration must not rewrite
event meaning.

## Verification

Run `tests/sqlite-store.test.mjs` and the golden replay cases in `tests/slice0.test.mjs`.

## Further reading

- [Atomicity and recovery](docs/atomicity-and-recovery.md)
- [Kernel projection model](../kernel/docs/projection-model.md)
