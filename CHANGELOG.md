# Changelog

Notable user-visible, compatibility, security, and packaging changes are recorded here. Internal implementation
steps and investigation history belong in pull requests, not release notes.

## [Unreleased]

### Added

- `/context` now shows per-ContextBlock-kind included token share, included/omitted counts, omitted estimated
  tokens, and a separate conversation/Tool-schema subtotal from replayable aggregate Session facts.
- Added end-to-end image input for Kimi K3 and other image-capable models: rich-TTY clipboard paste, safe image
  URL ingestion, bounded preprocessing, content-addressed original/prepared Artifacts, ordered Session replay,
  and an authorized `read_image` crop/detail Tool.

### Changed

- Kimi K3 now advertises its 1,048,576-token window, image input, `max`-only thinking effort, and `max` default.
  Legacy K3 low/high effort settings fall back to `max`; custom OpenAI-compatible endpoints remain text-only
  unless their `[[compatible]]` entry sets `image_input = true`.
- Chat Completions and Responses adapters now map ordered user media and tool-result images without persisting
  provider data URLs. Image context cost uses dimensions rather than base64 length.
### Deprecated

### Removed

### Fixed

### Security

- Image URLs use the existing DNS-pinned public-network boundary with independent byte limits, MIME plus
  magic-byte verification, HTTPS downgrade prevention, and Network capability enforcement. Image bytes and data
  URLs never enter Session events or SQLite.
### Documentation

- Added ADR-0028 and synchronized protocol, Agent, AI, Node, TUI, and CLI contracts for image ingestion,
  Artifact materialization, replay recovery, model capability gating, and the deferred video boundary.
## [0.7.1] - 2026-07-29

### Added

- Added end-to-end Memory capture and management: structured Session/Project/User scopes, provenance-backed
  `memory` proposals, `/memory` rich and line-mode lifecycle commands, explicit User promotion/pinning, and
  read-only Web provenance/usage audit.
- Added machine-wide local-user continuity under `$QI_HOME/state`, transactional/versioned Memory indexes,
  exact-scope and CJK retrieval, activation limits, and startup projection recovery.
- Session extract reports may emit `CLAIMED_MUTATION_WITHOUT_ACTIONS` when a responded Run claims a Workspace or
  Formal Plan mutation in prose without any completed write Action, and
  `RESERVED_RUN_FACTS_IN_MODEL_OUTPUT` for legacy internal fact tags committed as model text (diagnostic only;
  Run completion is unchanged).

### Changed

- Unified the TUI into a bounded committed timeline, provisional live strip, and protected control region.
  `standard` is the default of three timeline densities; consecutive same-Step read-only exploration groups
  after settlement, successful process output collapses on completion, exceptional evidence remains visible,
  and older Runs move behind the searchable `/runs` History Center.
- TUI committed facts and in-memory/SQLite Session projections now update incrementally with cold-replay
  fallback. Composer/activity ticks do not scan EventStore history, and process-local caches are discarded on
  discontinuity, failed validation, or transaction rollback without changing Session events or the database.
- Human gates no longer steal focus from a non-empty composer or follow-up editor. A persistent notice points to
  `Ctrl+G`, which opens Run Question → Plan Review → Next Run → path grant in priority order.
- Qi themes now use compatible semantic aliases and degrade through truecolor, ANSI-256, basic ANSI, and
  `NO_COLOR`; state glyphs and labels remain meaningful without color.
- Memory capture and retrieval now default on for new Runs without historical conversation backfill. Project
  claims remain project-local; only explicitly confirmed User claims cross projects. Context compilation
  considers at most 12 optional Memory blocks and records actual inclusion/omission through existing block IDs.
- `qi_session_inspect` / `inspectQiSession` and extract-session `--all` now surface Formal Plan short titles and
  bindings, Work Plan snapshots, bounded `modelReasoning`, write/read `actionFacts`, and file-vs-Git diff / process
  summaries; `analyze-qi-session` Skill 1.3.0 documents those diagnostic fields.
- Web Run Narrative now projects committed model reasoning as a Thinking block, shortens Accepted Formal Plan
  titles via `planBinding` metadata (with a bounded Formal Plan preview), and renders specialized cards for
  Work Plan todos, AskQuestion, process output tails, and file-mutation diffs instead of a generic Workspace
  diff fold for every Action.
- TUI `update_plan` Work Plan cards now keep a full ✔/◐/○ Todo list in the chat stream (including mid-Run
  collapsed Steps), with a `Working on N to-dos · M/N done` header instead of a one-line summary.
- Live `shell`/`script`/`verify` tails and failed cards keep up to three bounded evidence lines; settled successes
  collapse to one command-and-duration line unless expanded or shown in diagnostic density.
- Restored cross-Run conversation history now supplies only a local turn ordinal and coarse write settlement class
  in a Runtime-owned system ContextBlock. Durable IDs, Action/read counts, terminal details, paths, and tool
  payloads remain outside automatic model context and are available only through bounded introspection.
- Agent constitution and mode guidance now state that minimizing investigative tool calls does not skip
  `edit`/`write`, and that planned code blocks are not proof of a durable Workspace mutation.
- Executor timelines now render accepted Formal Plans as at most 200 terminal lines without paste
  classification; every preview shows the immutable local path, and longer plans add a Collapsed notice while
  Executor context remains complete. Live model reasoning keeps three display-wrapped lines; settled standard
  density uses an expandable `Thinking · duration` summary with the same bounded excerpt.
- Choice questions in Plan-mode `ask_question` now offer custom `Other…` input by default unless explicitly
  disabled, and confirmed timeline cards retain every question and option with selected, custom, or skipped
  results.
- Formal Plans now appear in the timeline, bounded to 200 rendered lines with their immutable local path, before
  the Plan Review choices are offered.

### Deprecated

### Removed

### Fixed

- Fixed Formal Plan drafting completion so a read-only `plan_document` Action cannot masquerade as a new
  revision; the Run now requires a completed write-effect create/edit before offering review.
- Removed legacy `<qi-run-facts>` tags from restored and committed assistant text so models cannot multiply or
  fabricate internal Session metadata in the visible timeline.
- Made the `plan_document` function parameters compatible with Moonshot/Kimi JSON Schema validation while
  preserving strict per-operation field checks inside the Tool.
- Fixed failed `plan_document` cards so ToolFailure envelopes show the operation, error code, and message instead
  of a nonexistent `rev undefined`.
- Fixed first-call `update_plan` loops by replacing model-supplied provisional Work item IDs with Runtime IDs;
  nonexistent update IDs now return explicit create/update guidance, and failed Todo cards show that reason.

### Security

- Credential-like Memory is rejected before source or candidate persistence, model-provided scope identifiers
  are ignored, and Agents cannot accept, promote, activate, correct, or forget User Memory.

### Documentation

- Added ADR-0027 for Interaction Timeline hierarchy, density, attention, long-session bounds, and incremental
  projection rules; updated the TUI/CLI and storage contracts.
- Documented Memory scope, storage, lifecycle, recovery, CLI/Web behavior, and corrected the
  `SqliteMemoryIndex` import path.

## [0.7.0] - 2026-07-28

### Added

- Added Formal Markdown Plan revisions, immutable SHA-addressed Plan documents, Agent-only `update_plan` Work
  Plans, and Plan-only in-Run AskQuestion with single/multiple/text/custom/skip interaction.
- Added declaration-only plugin contracts and `qi install/update/remove/list` for exact npm, pinned Git, and
  digest-pinned local sources. Installation never runs npm lifecycle scripts and publishes validated content to
  the shared content-addressed package store.
- Added the generation-2 `$QI_HOME` layout, canonical realpath-hash project IDs, private `state/` databases,
  project descriptors, Web discovery, and strict private-root safety checks.
- Added `prewarmTrustedExecutables()` to `@civaapple/qi-node/tools`, priming common PATH-resolved executables for the
  detected language stack (Node.js, Maven) at CLI startup so the first `search`/`find`/`shell`/`script`/`verify`
  call does not pay PATH-walk latency.
- Added `outputRef` to `shell`, `verify`, and `script` Tool output: when a run's stdout/stderr is truncated for
  model-context reasons, the complete stream is stored as a content-addressed Artifact and referenced instead of
  being discarded.
- Added a `codeact` Tool (under the existing `execute` capability) that runs a short generated program inside a
  network-off, read-only-root container; every nested `api.call` still passes through the normal Tool Registry,
  capability authorization, and Session event lifecycle. It registers only when `probeContainerRuntime()` from
  `@civaapple/qi-node/codeact` finds a responding `docker` or `podman` on the host.
- Added `ContainerProgramSandbox` support for inline `programSource` (in addition to `programFile`); the sandbox
  owns staging and cleanup for both, so callers never manage an ad hoc temp-file location themselves.
- Added `allowedTools` to `ControlledToolClient`: nested CodeAct tool calls outside the allowlist fail closed as
  `TOOL_NOT_ALLOWED` before any inspection or Session event.
- Added a guided `/verify` setup wizard: `scanVerificationCandidates()` (new in `@civaapple/qi-node/tools`) proposes
  verification commands from `package.json`, `pom.xml`, `AGENTS.md`, and `README.md`; a human confirms the
  selection in a `MultiSelectPanel`, and `writeVerificationManifest()` writes `.qi/qi.verify.json` through the
  same atomic-write and `loadVerificationProfiles()` validation path used by automatic inference.
- Added model-level Kimi Code profiles for `k3`, `k3-256k`, `kimi-for-coding`, and
  `kimi-for-coding-highspeed`, including 1M/256K context windows, K3 effort normalization, K2.7 thinking
  toggles, and streamed reasoning output.
- Added Kimi `reasoning_effort` user configuration, `--effort` launch override, and
  `KIMI_MODEL_THINKING_EFFORT` / `QI_REASONING_EFFORT` environment support.
- Added terminal dropdown fields with a final custom-input option, used by Kimi `/login` to select a known model
  or enter a future model ID while showing the effective effort and context-window defaults.

### Changed

- Accepting a new Formal Plan now atomically starts one whole-plan Agent Run with zero planning-history budget;
  Formal Plans no longer generate Todo items or `/next` gates. Legacy item plans keep their replay and `/next`
  behavior.
- `plan_document` is now a discriminated `create`/`read`/`edit` document tool with SHA freshness, atomic unique
  text patches, a 64 KiB limit, and rejection of detected secrets and Markdown task-list checkboxes.
- Consolidated 21 runtime publication units into the coordinated `qi-protocol`, `qi-ai`, `qi-agent`, `qi-node`,
  `qi-tui`, and `qi` CLI packages, with controlled subpath exports preserving cohesive module boundaries.
- Workspace `.qi` is now an allowlisted declaration/lock surface only. User Skills moved to
  `$QI_HOME/resources/skills`; project machine policy moved to `policy.toml`.
- `findTrustedExecutable()` now caches PATH resolution per command/Workspace root/PATH triple for the process
  lifetime, including in-flight de-duplication for concurrent lookups of the same executable.
- `TurnLoop` now authorizes and executes a Step's maximal consecutive runs of `read`-effect Actions concurrently
  instead of one at a time; write/execute/publish/spend effects remain strictly sequential, and model-facing
  tool-result feedback still preserves the model's original request order.
- Kimi Code now defaults to `k3`; without an explicit `context_window_tokens`, CLI context budgeting follows
  the selected Kimi model profile.
- Kimi API-key and device `/login` now persist the selected `model`, `reasoning_effort`, and editable
  `context_window_tokens` into user `config.toml` and apply all three to the live runtime without restart.

### Deprecated

### Removed

- Removed the 0.5 public package names and automatic reuse of 0.5 local data roots. Qi does not migrate or delete
  an old non-empty `$QI_HOME`.

### Fixed

- The active Working strip now retains the latest three model/tool stream lines; transient operator notices
  expire after four seconds and clear on the next submission, while Run outcome notices remain actionable.
- Terminal Markdown tables now wrap adaptively and fall back to vertical row fields on narrow screens instead
  of truncating long or right-side columns.
- Every Run now receives probed host-platform and shell-profile facts, including explicit Windows guidance and
  a same-Run rule against retrying an executable/profile assumption after the environment rejects it.
- `/tasks` now opens an interactive ProcessTask list where Enter stops the selected running task, terminal tasks
  are visibly disabled, and process-tree termination escalates after a bounded graceful wait.
- The Web workbench now keeps durable background ProcessTasks visible after their originating Run completes,
  refreshes their lifecycle over SSE, and reports command, PID, working directory, and expiry.
- Shell guidance now directs package-manager commands through the direct argument vector plus `workdir`, documents
  the Windows `NUL` device, and decodes identifiable UTF-16LE host diagnostics before bounded capture.
- Shell now validates executable paths and classifies malformed command strings and confirmed spawn-start errors
  as deterministic failures instead of parking the Run with an indeterminate effect.
- Shell and script children that explicitly disable color no longer inherit a conflicting `FORCE_COLOR` value
  that caused Node.js to emit a warning on stderr.
- Host-process children no longer inherit npm's lifecycle-exported `npm_config_allow_scripts`, so a Qi runtime
  launched through `npm run qi` can execute nested project-scoped npm commands without an ambient
  `EALLOWSCRIPTS` failure.

### Security

- Declarative package and `.qi` validation rejects secrets, executable/binary file types, path traversal,
  symlinks/junction escapes, oversize trees, lifecycle scripts, and same-layer resource ambiguity. Package
  registration never grants a Capability Lease.

### Documentation

- Documented six-package ownership, state/event responsibility, the generation-2 private layout, `.qi`
  boundaries, package trust flow, and executable-plugin deferral in the design map and ADRs.

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
