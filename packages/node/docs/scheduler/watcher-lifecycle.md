# Watcher lifecycle

A watcher is a durable, bounded promise to reconsider a Session when a time or external condition occurs.

## States

| State | Meaning |
| --- | --- |
| `active` | Eligible to observe and propose delivery |
| `stopped` | Explicitly revoked; no future Run may be emitted |
| `completed` | A registered external completion condition is satisfied |
| `expired` | Hard maximum lifetime reached |

Every watcher has `createdAt` and `expiresAt`; there is no immortal default. External completion conditions, such
as a merged pull request, close the watcher without requiring another model turn.

## Stop boundary

Stopping marks durable state and aborts any in-flight delivery before `TriggerSink` commit. After stop succeeds,
no callback may append a Run even if an external request resolves late.

## Attention

An active watcher can produce a trigger candidate, but proactive delivery still passes the Attention Gate. When
the gate denies delivery, no occurrence is reserved: a due timer remains eligible on a later tick, while an event
requires redelivery from its source. The scheduler has no separate durable deferred state.

See `tests/watcher-scheduler.test.mjs`.
