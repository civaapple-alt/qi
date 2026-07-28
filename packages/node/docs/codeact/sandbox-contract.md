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

## Program source input

`ContainerProgramSandbox` accepts exactly one of `programFile` (an existing path) or `programSource` (inline ES
module text). Both are staged into the same throwaway directory as `program.mjs`; the sandbox creates and removes
that staging directory itself in both cases, so a caller integrating CodeAct into a Tool never has to decide where
to place a generated temp file or when to delete it.

## Controlled API

`ControlledToolClient` validates each nested request, obtains capability authority, writes Action lifecycle events,
and uses the Tool Registry and Effect Journal. Nested calls therefore remain independently explainable.

An optional `allowedTools` list further narrows which tool names a program may call, independent of what the
subject's capability leases would otherwise authorize. A name outside the allowlist is rejected as
`TOOL_NOT_ALLOWED` before the Tool Registry is consulted and before any Session event is written — the same
fail-closed shape as a capability denial, but decided one layer earlier. Callers use this to block a sandboxed
program from recursing into another `codeact` invocation or chaining into `delegate`, regardless of how broad the
outer grants are.

## Settlement

The program can succeed only when its nested calls have known settlements. A denied call becomes structured input
to program handling. An indeterminate nested effect parks the enclosing flow and blocks automatic replay.

## Availability

Building a valid container invocation is not proof that a container ran. If isolation is unavailable, fail
explicitly unless a separately authorized sandbox adapter is configured. `probeContainerRuntime()` spawns
`<runtime> version …` for each candidate (`docker`, then `podman` by default) with a short timeout and returns the
first one that exits successfully, or `undefined` if none respond; callers should skip registering a
container-backed capability rather than registering one that will fail every actual run.

See `tests/codeact.test.mjs`.
