# Changelog

Notable user-visible, compatibility, security, and packaging changes are recorded here. Internal implementation
steps and investigation history belong in pull requests, not release notes.

## [Unreleased]

### Added

- Added `prewarmTrustedExecutables()` to `@civaapple/qi-tools`, priming common PATH-resolved executables for the
  detected language stack (Node.js, Maven) at CLI startup so the first `search`/`find`/`shell`/`script`/`verify`
  call does not pay PATH-walk latency.
- Added `outputRef` to `shell`, `verify`, and `script` Tool output: when a run's stdout/stderr is truncated for
  model-context reasons, the complete stream is stored as a content-addressed Artifact and referenced instead of
  being discarded.
- Added a `codeact` Tool (under the existing `execute` capability) that runs a short generated program inside a
  network-off, read-only-root container; every nested `api.call` still passes through the normal Tool Registry,
  capability authorization, and Session event lifecycle. It registers only when `probeContainerRuntime()` from
  `@civaapple/qi-codeact` finds a responding `docker` or `podman` on the host.
- Added `ContainerProgramSandbox` support for inline `programSource` (in addition to `programFile`); the sandbox
  owns staging and cleanup for both, so callers never manage an ad hoc temp-file location themselves.
- Added `allowedTools` to `ControlledToolClient`: nested CodeAct tool calls outside the allowlist fail closed as
  `TOOL_NOT_ALLOWED` before any inspection or Session event.
- Added a guided `/verify` setup wizard: `scanVerificationCandidates()` (new in `@civaapple/qi-tools`) proposes
  verification commands from `package.json`, `pom.xml`, `AGENTS.md`, and `README.md`; a human confirms the
  selection in a `MultiSelectPanel`, and `writeVerificationManifest()` writes `.qi/qi.verify.json` through the
  same atomic-write and `loadVerificationProfiles()` validation path used by automatic inference.

### Changed

- `findTrustedExecutable()` now caches PATH resolution per command/Workspace root/PATH triple for the process
  lifetime, including in-flight de-duplication for concurrent lookups of the same executable.
- `TurnLoop` now authorizes and executes a Step's maximal consecutive runs of `read`-effect Actions concurrently
  instead of one at a time; write/execute/publish/spend effects remain strictly sequential, and model-facing
  tool-result feedback still preserves the model's original request order.

### Deprecated

### Removed

### Fixed

### Security

### Documentation

## [0.5.1] - 2026-07-27

### Added

- Added configurable 8–100 Step budgets (default 32), a tool-free final handoff Step, and explicit
  `step.completed.finishReason = handoff` continuation history.
- Added digest-guarded Workspace Skill draft export/update through the dedicated Skill service, including sibling
  staging, backup, stale-draft detection, and indeterminate recovery markers.
- Added bounded Session/Run/Step/Action queries and the read-only `qi_session_inspect` Tool in
  `@civaapple/qi-introspection`, plus matching analyze-qi-session filters.
- Added `npm run verify:focused -- tests/<name>.test.mjs …` for build-once targeted iteration.
- Added bounded 1-based line-range reads whose freshness metadata continues to cover the complete file.
- Added durable, pre-authority freshness rebasing for safe same-Step `edit → edit` chains.

### Changed

- Development verification now favors affected tests during iteration, one full typecheck/test pass for
  cross-package completion, and package/CLI gates only when those surfaces change; releases still run all gates.
- Active TUI transcripts retain bounded Diffs for completed mutations in the visible eight-Step window.

### Deprecated

### Removed

### Fixed

- Plan/Ask mode Kernel projection now allows the read-only `qi_introspect` tool, matching capability mode
  policy. Previously a Plan-mode model call to inspect self-model sections failed the whole Run with
  `INVALID_MODEL_ACTION` / `MODE_TOOL_DENIED`.
- Ask/Plan mode tool or effect denials are recovered as `model.action.rejected` (`TOOL_INPUT`) feedback so the
  model can correct course. Kernel and capability mode allowlists are exported and lockstep-tested so dual-copy
  drift is caught in CI.
- Failed shell/script/verification cards now unwrap exit, stderr/stdout, timeout, and Workspace-change evidence
  from structured Tool failure details.

### Security

- Generic file tools continue to deny `.qi`, `.git`, and `.artifacts`; only the authorized, Effect-Journaled
  Skill service can update `.qi/skills`, and uncertain updates cannot auto-retry.

### Documentation

- Documented budget handoff recovery, Session self-inspection, and the Workspace Skill update boundary.

## [0.5.0] - 2026-07-27

### Added

- MIT licensing and public-package metadata for the CLI and 21 Runtime packages.
- Isolated package consumers, release-candidate auditing, and installable CLI preview checks.
- `@civaapple/qi-agent`, `@civaapple/qi-introspection`, and reusable `@civaapple/qi-tui` package surfaces.
- Provenance-bearing GitHub Actions publishing with a post-bootstrap migration to tokenless npm trusted
  publishing.

### Changed

- Renamed the application directory from `apps/tui` to `apps/cli`.
- Changed the installed executable to `qi`.
- Adopted `@civaapple/qi` for the CLI and `@civaapple/qi-*` for Runtime packages.
- Set `civaapple-alt/qi` as the canonical repository.
- Unified product identity, environment variables, local data paths, Session actors, evidence types, and public
  APIs under `Qi`, `QI_*`, `.qi`, and `qi.*`.
- Consolidated public design documentation around the current architecture, decisions, and roadmap.

### Deprecated

### Removed

- Removed the local Jekyll/Docker documentation site and chronological design/process documents from the public
  repository.

### Fixed

- Made CodeAct container staging paths portable across Windows, Linux, and macOS.

### Security

- Expanded ignored-file protection for local credentials, registry configuration, logs, Runtime artifacts,
  packed archives, and editor state.
- Kept the monorepo root private and metadata-only when packed accidentally.

### Documentation

- Replaced iteration-oriented notes with concise contributor-facing architecture and release documentation.
- Restored the foundational product vision around life-like continuity, human-Agent coexistence,
  同行/追寻/守望, and bounded Turn/Goal/Time/Proactive control.
- Added the Contributor Covenant and a private maintainer email as the security disclosure channel.

## [0.4.0] - 2026-07-24

### Added

- Append-only Session events, Kernel projection, SQLite persistence, committed SSE streaming, and crash recovery.
- Provider-neutral model adapters, bounded context compilation, credential handles, and secret redaction.
- Default-deny capability leases, typed Tool phases, precise file mutation, read-only mounts, Effect Journal
  settlement, and bounded ProcessTasks.
- Ask/Plan/Agent modes, durable Questions and Plan review, terminal UI controls, and a read-only Web workbench.
- Goal/evidence evaluation, provenance-backed memory, Skills, MCP quarantine, CodeAct, graph governance,
  depth-1 delegation, and bounded scheduling.
- CLI/package build, replay fixtures, deterministic tests, and live-provider acceptance harnesses.

### Changed

- Completion now distinguishes a model response, a terminal Run, and evidence-backed verification.
- Provisional model/process activity is observable without becoming durable Session truth.
- TUI transcript work is bounded through paint classification, caching, and reversible history folding.

### Security

- Authority grants and Action start facts persist before executor entry.
- Non-read effects use idempotent settlement and are never automatically retried when indeterminate.
- Protected Runtime/VCS paths remain outside ordinary Agent file authority.
