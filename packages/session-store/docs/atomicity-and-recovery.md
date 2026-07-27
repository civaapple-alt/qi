# Atomicity and recovery

`SqliteEventStore` persists a Session stream as ordered immutable rows guarded by an expected version.

## Append transaction

```text
begin
  read current version
  compare expected version
  validate every event and Session identity
  insert the complete batch in order
commit
```

Any failure rolls back the whole batch. A caller may reload and decide how to handle concurrency, but cannot
assume a prefix was committed.

## Restart contract

After closing and reopening SQLite:

- stream version remains stable;
- ordered events remain byte-equivalent in domain meaning;
- the Kernel can reconstruct the same Session view;
- stale expected versions are still rejected.

Storage recovery does not settle running effects. `SessionSupervisor` and the Effect Journal handle that domain
problem by appending explicit reconciliation facts.

## Schema evolution

Database migrations may change indexes or physical representation but must not reorder, rewrite, or reinterpret
Session events. Add restart and rollback tests for every migration.
