# `@civaapple/qi-node/scheduler`

Durable, bounded proactive watchers with attention policy and idempotent Session triggers.

## Purpose

The Scheduler supports time- and event-based continuation without granting unbounded background autonomy. A
watcher has explicit lifetime, state, delivery identity, attention checks, and external completion conditions.

## Non-goals

- A watcher is not an immortal daemon or a hidden Agent loop.
- External events do not bypass Session trigger and capability boundaries.
- Suppressed attention is not silently converted into successful delivery.

## Core model

`SqliteWatcherScheduler` persists watcher definitions and delivery records. `SessionEventTriggerSink` appends a
stable Run trigger. External event IDs and stable Run IDs make delivery replayable after crashes.

## Behavioral invariants

- A stopped watcher cannot emit another Run.
- Every watcher has a hard maximum lifetime.
- External completion can close a watcher automatically.
- Event delivery is idempotent by external event ID.
- Attention policy is checked before proactive interruption.
- Stopping an in-flight watcher aborts before trigger commit.

## Failure semantics

Durable watcher states are `active`, `stopped`, `completed`, and `expired`. Attention denial produces no delivery;
a duplicate occurrence produces no second Run; and a trigger failure leaves the reserved occurrence pending for
recovery with the same stable Run ID. These outcomes are observable without inventing extra watcher states.

## Install and minimal use

```sh
npm install @civaapple/qi-node/scheduler
```

```ts
import { SqliteWatcherScheduler } from "@civaapple/qi-node/scheduler";

const scheduler = new SqliteWatcherScheduler(":memory:", {
  async trigger({ runId }) {
    return runId;
  },
});
try {
  console.log(scheduler.get("missing")); // undefined
} finally {
  scheduler.close();
}
```

## Public API

Watcher types, `SqliteWatcherScheduler`, attention and external condition ports, `TriggerSink`, and
`SessionEventTriggerSink`.

## Change guide

New trigger modes must define lifetime, deduplication key, cancellation boundary, attention policy, external
completion, and crash replay before implementation.

## Verification

`tests/watcher-scheduler.test.mjs` covers lifecycle, idempotency, attention, crash replay, and in-flight stop.

## Further reading

- [Watcher lifecycle](docs/watcher-lifecycle.md)
- [Delivery semantics](docs/delivery-semantics.md)
- [Extension and scheduling design](../../design/system-design.md#8-extensions-skills-mcp-codeact-graph-delegation-scheduling-and-introspection)
