# Effect Journal

The Effect Journal protects non-read operations when retries and crashes make “did it happen?” uncertain.

## Lifecycle

```text
reserved -> started -> completed
                    -> failed
                    -> indeterminate
```

An idempotency key is derived from a stable scope, tool identity, normalized input, and resources. Before
execution, the registry asks the journal to begin that key.

## Re-entry behavior

- Completed: replay the recorded settlement without executing again.
- Failed: expose the recorded failure according to retry policy.
- Reserved but not started: safe cancellation or explicit retry may be possible.
- Started and unsettled: reconcile to indeterminate after crash.
- Indeterminate: block automatic retry until a human or external reconciler resolves the effect.

## Why reads differ

Pure reads can usually repeat, but their observations can become stale. Writes and executions can duplicate
irreversible effects, so they require durable settlement in addition to capability authorization.

The journal does not replace an external idempotency key when a remote API supports one; use both and record the
relationship. See `tests/workspace-safety.test.mjs` for serialization, replay, and indeterminate blocking.
