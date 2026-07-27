# CodeAct sandbox contract

CodeAct executes a short generated program as coordination logic. The program receives a narrow API whose calls
become ordinary Qi Actions; it never receives privileged runtime objects.

## Default sandbox

- Stage only the selected program and explicit inputs.
- Disable network access.
- Use a read-only root filesystem.
- The current container adapter mounts only the staged program and provides no writable output mount.
- Avoid host credentials, sockets, and broad workspace mounts.
- Enforce time and process limits at the adapter boundary.

## Controlled API

`ControlledToolClient` validates each nested request, obtains capability authority, writes Action lifecycle events,
and uses the Tool Registry and Effect Journal. Nested calls therefore remain independently explainable.

## Settlement

The program can succeed only when its nested calls have known settlements. A denied call becomes structured input
to program handling. An indeterminate nested effect parks the enclosing flow and blocks automatic replay.

## Availability

Building a valid container invocation is not proof that a container ran. If isolation is unavailable, fail
explicitly unless a separately authorized sandbox adapter is configured.

See `tests/codeact.test.mjs`.
