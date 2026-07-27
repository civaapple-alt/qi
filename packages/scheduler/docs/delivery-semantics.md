# Watcher delivery semantics

External systems commonly redeliver events, and the scheduler can crash between appending a Run and recording
local completion. Stable identities make this recoverable without duplicate Runs.

## Identity

Event watchers persist the external event ID. The scheduler derives or stores a stable Run ID for that watcher and
delivery. Reprocessing the same external ID resolves to the existing delivery rather than minting new work.

## Delivery sequence

1. Confirm watcher is active and within lifetime.
2. Evaluate external completion and attention policy.
3. Reserve the external delivery identity.
4. Ask `TriggerSink` to append the stable Run trigger.
5. Persist delivery completion.

If a crash occurs after step 4, replay uses the same Run ID; Kernel/store identity rules reject accidental
duplication. If stop wins before trigger commit, delivery aborts.

Attention denial occurs before reservation. A trigger failure after reservation leaves the occurrence pending;
`recoverPending()` retries it with the preallocated Run ID rather than minting a new occurrence.

## Guarantees and limits

The scheduler provides idempotent trigger creation for a stable external ID. It does not make the external source
exactly-once and does not guarantee user interruption when attention policy suppresses delivery.

See the crash replay and in-flight stop cases in `tests/watcher-scheduler.test.mjs`.
