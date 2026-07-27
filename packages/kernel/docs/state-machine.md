# State machine and recovery

The Kernel distinguishes lifecycle state from recovery policy. It rejects impossible transitions; supervisors
decide which explicit recovery events to append after observing durable state.

## Important state distinctions

| State | Meaning | Automatic retry |
| --- | --- | --- |
| `failed` | Executor or evaluated operation settled unsuccessfully | Policy-dependent |
| `cancelled` | Work was intentionally prevented or stopped | No implicit retry |
| `indeterminate` | Execution may have affected the world, but settlement is unknown | Never |
| `parked` | Run stopped at a safe boundary and can await direction | Only explicit resume |

## Crash boundaries

- Granted but not started: the supervisor can cancel because executor entry is not durable.
- Started but unsettled: the supervisor marks the effect indeterminate after restart.
- Settled Action but abandoned active Step/Run: the current `SessionSupervisor` completes the open Step with an
  error boundary and parks the Run for review; it does not silently resume process-local control flow.

Recovery never edits or deletes the earlier fact. It appends another event that explains the reconciliation.

## ProcessTask lifecycle

```text
task.started → running → task.stop.requested → stopping → task.exited
                      └───────────────────────────────→ task.exited
                      └───────────────────────────────→ task.lost
```

Task start requires its originating Action to be running. The Action may then complete because it settled the
act of starting the process; the ProcessTask remains Session-scoped and may outlive that Run. Exit, explicit
stop, hard expiry, and lost ownership remain different terminal explanations. After restart, a runtime that
cannot prove ownership appends `task.lost` rather than guessing from a PID or retrying the command.

## Adding a transition

Define the event, prerequisite state, resulting state, terminal interactions, replay behavior, and recovery meaning.
Then add both a valid-path case and the most dangerous invalid predecessor case to `tests/slice0.test.mjs`.
