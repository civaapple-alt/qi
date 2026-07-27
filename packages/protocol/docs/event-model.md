# Session event model

The Session event stream is Qi's durable truth. Every state visible in a projection must be derivable from
ordered `SessionEvent` values without consulting live objects, provider caches, or UI state.

## Identity hierarchy

```text
Session
├── Run
│   └── Step
│       └── Action
└── ProcessTask ── origin: Run / Step / Action
```

Goals, evaluations, evidence, leases, receipts, and memory claims link into this hierarchy through explicit
identifiers. An event may advance an existing entity but may not re-parent it.

## Producer contract

1. Construct a schema-valid event with stable entity IDs and actor metadata.
2. Load or retain the expected stream version.
3. Ask the Event Store to append the complete atomic batch.
4. Publish only after commit succeeds.

Events describe facts that happened, not commands that might happen. Names therefore use completed lifecycle
language such as authority granted, action started, or action failed.

A schema-invalid call or a call beyond the deterministic Step batch envelope is recorded as
`model.action.rejected`. It remains attached to the Step's model output and never becomes an Action, because it
was rejected before authority or executor entry.

`safety.redaction.applied` is an append-only audit fact emitted when high-confidence secret material is removed
at model input, model output, Tool output, context compaction, or persistence. It deliberately contains no
matched value and has no mutable projection state.

`context.compacted` records a current Step boundary, the completed source Step, original and compacted token
estimates, message count, pressure reason, and content-addressed Artifact reference. It changes only future model
working context. The source model, Action, authority, and settlement events remain append-only truth.

A ProcessTask begins only through a running Action. `task.started` records command identity, origin, PID, hard
expiry, and private log reference; `task.stop.requested` records user/runtime intent; `task.exited` records a
known terminal process result; `task.lost` records that ownership can no longer be proven. Pipe chunks remain a
bounded provisional activity channel rather than inflating the durable stream.

## Ordering contract

Sequence is authoritative within a Session. Timestamps aid explanation but do not reorder facts. Producers must
persist prerequisite facts before dependent facts; the Kernel rejects a schema-valid event in an illegal position.

## Settlement vocabulary

An Action may complete, fail, be cancelled, or become indeterminate. A Run may complete, fail, cancel, or park.
These are separate protocol facts because they imply different retry and recovery behavior.

## Evidence

See `tests/slice0.test.mjs` for deterministic replay, entity ownership, prerequisite ordering, and terminal-state
exclusivity.
