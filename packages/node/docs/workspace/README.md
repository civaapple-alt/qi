# `@civaapple/qi-node/workspace`

Isolated world adapters, freshness observations, process boundaries, and durable effect settlement.

## Purpose

Workspace adapters define the concrete slice of the world an Agent can observe or change. The Effect Journal
protects non-read operations from duplicate execution when retries or crashes make settlement uncertain.

## Non-goals

- Workspace isolation does not grant authority; capability checks remain separate.
- It does not decide which tool or task should run.
- It does not treat host access or Docker availability as implicit success.

## Core model

`LocalWorkspace` uses lexical root containment and freshness observations. `ContainerWorkspaceAdapter` runs a
configured Workspace mount with network disabled and both container root and Workspace read-only by default.
`GitWorktreeAdapter` isolates repository changes. `SqliteEffectJournal` reserves, starts, and settles effects by
stable intent and idempotency keys.

## Behavioral invariants

- `LocalWorkspace` rejects lexical traversal outside the configured root. Symlink rejection is enforced by the
  higher-level file tools; this adapter alone is not a symbolic-link security boundary.
- Writes based on stale observations are rejected.
- Non-read effects are serialized through a durable journal.
- Completed effects replay their settlement; indeterminate effects block automatic re-entry.
- Host process helpers scrub credential-like environment names by default, remove an inherited `FORCE_COLOR`
  when a caller explicitly supplies `NO_COLOR`, and can terminate process trees on timeout or cancel.
- After timeout or abort, `runHostProcess` awaits graceful tree termination, escalates with
  `forceTerminateProcessTree`, and force-settles the Promise if the child still does not exit so callers cannot
  hang forever waiting for `close`.
- `runHostProcess` truncates inline `stdout`/`stderr` at `outputLimitBytes` by default. A caller that also sets a
  larger `captureLimitBytes` additionally receives `stdoutFull`/`stderrFull` (bounded by that ceiling) for the
  specific stream(s) that were truncated, so a truncated run's full output can still be preserved by the caller
  instead of being discarded; omitting `captureLimitBytes` keeps prior behavior unchanged.

## Failure semantics

Unavailable isolation fails honestly. Executor uncertainty becomes `indeterminate`, not ordinary failure.
Callers need explicit reconciliation before retrying an unknown effect.

## Install and minimal use

```sh
npm install @civaapple/qi-node/workspace
```

```ts
import { LocalWorkspace } from "@civaapple/qi-node/workspace";

const workspace = new LocalWorkspace(process.cwd());
const observation = await workspace.observe("README.md");
```

## Public API

`LocalWorkspace`, `ContainerWorkspaceAdapter`, `GitWorktreeAdapter`, host-process helpers
(`scrubCredentialEnvironment`, `runHostProcess`, `terminateProcessTree`, `forceTerminateProcessTree`,
`waitForChildExit`), `EffectJournal`, and `SqliteEffectJournal`. `scrubCredentialEnvironment` removes
credential-shaped variables and npm's ambient lifecycle-exported `npm_config_allow_scripts`, preventing
`npm run qi` from changing the policy layer seen by nested project-scoped npm commands.

## Change guide

Keep authority, isolation, and effect settlement independent. New adapters must document trust assumptions and
prove path, process, crash, and cleanup behavior.

## Verification

`tests/workspace-safety.test.mjs` is the primary evidence; built-in integration is covered by
`tests/tools-capability.test.mjs`.

## Further reading

- [Effect Journal](docs/effect-journal.md)
- [Isolation model](docs/isolation.md)
- [Workspace design](../../design/system-design.md#4-workspace-authority-and-effects)
