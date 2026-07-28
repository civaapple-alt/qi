# Qi repository guide

This file is the operational contract for coding agents and maintainers changing Qi.
It is intentionally short. Follow links progressively instead of loading every design document.

## Start here

1. Read [README.md](README.md) for commands and the current implementation surface.
2. Read [design/README.md](design/README.md) to choose the smallest relevant reading path.
3. Read the `README.md` in every package you plan to change.
4. Read package-local `docs/` only for the state machine, safety boundary, or integration being changed.
5. Treat tests as executable behavioral evidence.

## Sources of truth

When documents disagree, use this order and fix the stale lower-level document in the same change:

1. Current architecture and cross-package decisions under `design/`.
2. Package behavioral contracts in `packages/*/README.md` and `packages/*/docs/`.
3. Runtime schemas and public TypeScript types.
4. Tests and golden traces for currently implemented behavior.

Tests do not silently override an accepted design decision. A mismatch is a design or implementation
issue that must be made explicit.

## Non-negotiable invariants

- The append-only Session event stream is the durable truth; projections are rebuildable views.
- Persist authority grants and `ActionStarted` before entering a tool executor.
- Capability checks deny by default, are scoped to the current intent, and cannot be widened by delegation.
- Tool discovery, schema validation, authorization, execution, and settlement remain separate phases.
- Non-read effects go through the Effect Journal. An indeterminate effect is never retried automatically.
- `failed`, `cancelled`, `parked`, and `indeterminate` are different outcomes and must not collapse into one boolean.
- A Run cannot become terminal while an Action has an unknown settlement.
- Verified completion requires matching evidence; uncalibrated semantic judgment projects to `unknown`.
- Graphs may narrow the sampling domain but may not bypass deterministic guards or capability checks.
- Memory is provenance-backed, correctable, forgettable, and cannot self-promote sensitive or relational claims.
- Skills and MCP metadata do not grant authority. Remote tools remain quarantined until explicitly bound.
- Steering is applied only at a safe Step boundary.
- Proactive watchers are bounded by lifetime, attention policy, idempotent delivery, and external completion.
- Multi-Agent execution remains opt-in and must not expand the parent Session's authority.
- Repository verification profiles are frozen at runtime startup; they accept no model-supplied commands or
  arguments and do not inherit provider credentials.
- `.qi`, `.git`, and `.artifacts` are protected runtime/VCS paths and never enter Agent file-tool authority.

## Package boundaries

- `protocol` owns wire-level IDs and Session event schemas; it contains no orchestration.
- `ai` owns the portable model protocol, provider adapters, and deterministic Context Compiler; provider state
  must not leak into Session truth.
- `agent` owns Kernel transition validation, TurnLoop/EventWriter orchestration, capability policy, portable
  Tool/Effect ports, evaluation, memory policy, Coordinator/Graph behavior, introspection, and declarative
  extension contracts. It never depends on `node`, `tui`, or `apps/*`.
- `node` owns Node-specific paths, SQLite stores, Workspace/process adapters, built-in Tools, Skills, MCP,
  CodeAct, Scheduler, stream/SSE, encrypted credentials, memory indexes, and declarative package installation.
- State/event ownership remains explicit: `protocol` defines facts; `agent/kernel` validates and projects;
  `agent/loop` produces events; `node/storage` persists them; `node/stream` transports committed facts.
- `tui` owns reusable terminal projections and local component state; it does not own auth, policy, persistence,
  Tool construction, effects, or process lifecycle.
- `apps/cli` is the `@civaapple/qi` execution composition; other `apps/*` are control and understanding surfaces,
  not alternate package-level runtimes.
- `$QI_HOME` holds machine-private state. Workspace `.qi` holds only allowlisted declarations and locks; ordinary
  Agent file tools cannot access it.

See [design/README.md](design/README.md) for the full package map and change-oriented reading paths.

## Change protocol

Before editing:

- Identify the owning package and its downstream consumers.
- State which invariant or contract is changing.
- If behavior changes across package boundaries, update `design/decisions.md` before implementation.

While editing:

- Extend existing schemas and state machines explicitly; do not smuggle state through free-form strings.
- Keep provider, transport, UI, and storage details behind ports.
- Add the narrowest test that proves both the new path and the important denied or recovery path.
- Update the owning package README or topic document when its contract, failure semantics, or change guide changes.
- Add a concise `CHANGELOG.md` entry for user-visible behavior, protocol, security, migration, or compatibility
  changes. Put it under `## [Unreleased]` in the matching fixed subsection (`Added` → `Changed` → `Deprecated` →
  `Removed` → `Fixed` → `Security` → `Documentation`); do not invent new headings or reorder them.

During iteration, run only the narrow tests affected by the change:

```bash
npm run verify:focused -- tests/<name>.test.mjs
```

Before finishing a cross-package change, run typecheck and the complete test suite once. Run package and CLI
acceptance gates only when their corresponding surface changed:

```bash
npm run typecheck
npm test
```

- Run `npm run packages:check` for public package API, manifest, or dependency changes.
- Run `npm run accept:preview` for CLI packaging, installation, or startup changes.
- Releases still run all four gates.

## Documentation rules

- Prefer links to canonical definitions over copying long lists of types or events.
- Explain why a boundary exists, the observable behavior it guarantees, and how failure is represented.
- Include at least one test or golden trace as executable evidence for every critical invariant.
- Keep package `README.md` files useful in isolation; put long sequences, recovery tables, and integration details in `docs/`.
- Keep the public design set focused on current architecture, accepted decisions, and the roadmap; implementation
  diaries and temporary investigation notes belong in pull requests.
