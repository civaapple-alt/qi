# Protocol compatibility

Session history can outlive the process and package version that wrote it. Protocol changes must therefore
preserve replay or provide an explicit migration boundary.

## Preferred changes

- Add a new event variant for genuinely new facts.
- Add optional fields with deterministic projection defaults.
- Add a new typed ID rather than reusing a semantically different one.
- Keep provider- and transport-specific payloads behind adapters or Artifacts.

## High-risk changes

- Renaming or removing an event type.
- Changing the meaning of an existing terminal state.
- Making a previously optional ordering relationship mandatory without migration.
- Reinterpreting a string field as a different domain concept.
- Adding process-local handles that cannot survive serialization and replay.

## Review checklist

1. Can old history still pass `parseSessionEvent()`?
2. Does `replaySession()` produce the same meaning for old events?
3. Do SQLite storage and SSE transport preserve the new shape?
4. Can mixed-version clients safely ignore or understand the addition?
5. Are golden traces and package docs updated?

Until a formal version envelope is added, incompatible event changes require an explicit ADR and migration tool;
they must not be merged as an ordinary refactor.

The durable-format policy, generation-1 interpretation, fail-closed preflight, and migration release gates are
normative in [ADR 0014](../../../design/decisions.md#adr-0014-version-pre-stable-persistence-boundaries-explicitly).
