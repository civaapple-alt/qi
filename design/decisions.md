# Current architecture decisions

This document records Qi's current cross-package decisions. It intentionally describes the architecture
that contributors must preserve, rather than the chronological path used to reach it. Stable ADR identifiers
remain in headings so code, tests, and discussions can refer to a decision without depending on a directory of
historical records.

For package ownership and the end-to-end model, see [system-design.md](system-design.md). Package-local details
belong in `packages/*/README.md` and `packages/*/docs/`.

## ADR-0001: redact secrets at model and durable-event boundaries

- Tool output is sanitized before effect settlement, model feedback, and Session events.
- Portable messages are sanitized immediately before provider requests.
- Event payloads are sanitized as a final persistence guard.
- Redaction emits category/count audit facts, never the matched value.
- The policy targets high-confidence credential shapes; it is not a general PII detector.

Opaque credential handles remain the preferred transport. Previously persisted secrets are not silently rewritten.

## ADR-0002: separate model window, output reserve, and working context

- Provider/model window, next-response reserve, and prompt budget are distinct values.
- The adapter and Turn Loop use the same resolved limits.
- Settled tool exchanges may be compacted into deterministic summaries plus Artifact references.
- Session events and Artifacts remain complete durable evidence; compaction changes only future model input.
- If required context still cannot fit, the Run parks with a budget outcome.

## ADR-0003: use freshness-checked precise file mutation

- `read`, `edit`, `write`, `move`, and `remove` remain separate operations.
- `read` may return a bounded 1-based line range, but its size and freshness hash always describe the complete
  file so a partial observation cannot weaken mutation freshness.
- `edit` requires a previously observed content hash and one unique target.
- Newline normalization may bridge CRLF/LF transport differences; untouched bytes and UTF-8 BOMs are preserved.
- Missing, ambiguous, stale, and no-op edits fail before mutation.
- Consecutive `edit` calls to the same resource in one Step may rebase only from the chain's original digest to
  the latest successfully settled digest. The Loop re-inspects before authority and records
  `action.freshness.rebased`; mixed mutations and unproven digest ancestry still fail closed.
- Generic shell execution is not the preferred file-edit transport.

A future cross-file patch operation must define per-resource authority, partial settlement, recovery, and replay
before it can enter the Tool Registry.

## ADR-0004: discover Skills progressively and install them through a bounded service

- User Skills live under `$QI_HOME/resources/skills`; Workspace Skills under `.qi/skills` shadow equal names.
- Only validated metadata enters normal context. Instructions and declared resources load on demand.
- Skills contribute knowledge, never authority.
- Bare-name installation resolves only from explicit local compatibility roots; it does not search the network.
- Installation validates recognized content in a temporary sibling and publishes atomically; it remains
  create-only and cannot silently overwrite an existing Skill.
- Ordinary file tools never receive `.qi` authority. The dedicated Skill service may export an installed
  Workspace Skill to a new ordinary draft directory, then update it only when the exported digest is still
  current.
- Workspace updates revalidate paths, symlinks, file bounds, metadata, and digest immediately before publication.
  They use sibling staging, backup, and recovery markers under Effect Journal control; uncertain publication is
  indeterminate and is never retried automatically.
- Model-facing Skill mutation is limited to Workspace scope and cannot install or update globally.

## ADR-0005: keep provisional activity outside durable Session truth

- Model text, model reasoning, and Action output may stream through a bounded, redacted, process-local activity
  channel.
- Consumers may coalesce or drop intermediate activity.
- Provisional activity is not completion evidence, Tool feedback, or replay state.
- Terminal model text and reasoning, Action settlement, failure meaning, and Artifact references enter the
  Session stream once. A UI may render committed reasoning as a distinct Thinking block, but it remains
  explanatory model output rather than evidence.

After a crash, only committed events and Artifacts are reconstructed.

## ADR-0006: represent long-lived processes as bounded ProcessTasks

- Finite commands settle inside an Action; servers and watchers use an explicit background Task operation.
- A ProcessTask has Session/Run/Step/Action ownership, a hard expiry, bounded logs, and a distinct lifecycle.
- Starting a Task requires separate background authority and completes only after process/log ownership exists.
- Understanding surfaces render the durable ProcessTask projection independently of the originating Action so a
  completed Run or folded narrative cannot make a still-running background process disappear.
- Stop intent is durable before process-tree termination.
- Recovery marks unverifiable processes `lost`; it never guesses settlement or automatically restarts them.

## ADR-0008: limit Subagent delegation to one isolated layer

- Delegation requires a durable Control Receipt and a strict subset of the parent's capability lease.
- A child receives only an objective, boundaries, and allowlisted Artifact context references.
- The child runs in its own Session and cannot delegate.
- The parent receives structured deliverables and a short summary Artifact, not the child transcript.
- Contracts, resource envelopes, and settlement are durable.
- Recovery cancels unsettled delegation before parking the parent; child work is not automatically retried.

Multi-Agent execution remains opt-in and the parent remains responsible for integration and verification.

## ADR-0009: use explicit provider profiles and execution-side credentials

- Provider profiles declare wire API, base URL, auth schemes, transport capabilities, and model-specific context
  windows or thinking modes where those differ within one provider.
- Qi never probes failed endpoints to guess a wire API.
- Responses and Chat Completions adapters remain thin implementations of one portable model protocol.
- Provider-specific thinking fields are derived deterministically from the selected model profile and explicit
  operator configuration; unknown effort values fail before network execution.
- Credentials are sealed and resolved through a broker only at the provider boundary.
- Tokens, authorization headers, OAuth codes, and PKCE material never enter TOML, Session events, or Artifacts.
- `/login` owns interactive authentication and may atomically update non-secret provider routing, model effort,
  and context-window defaults; credentials remain sealed separately. Unauthenticated startup is allowed, but
  Runs fail closed.

## ADR-0011: make human control and Ask/Plan/Agent modes durable

- Session mode is durable `ask | plan | agent`; a Run freezes its mode when triggered.
- Ask is read-oriented. Plan adds managed Plan revisions and read-only depth-1 research delegation. Agent uses the
  granted launch upper bound.
- Mode narrows authority; it never creates authority.
- A Formal Plan is a self-contained, immutable-revision Markdown design for a fresh Executor. It is not a Todo
  list and carries no mutable implementation status.
- Plan-mode clarification Questions, approval outcomes, Plan review, and legacy next-Run choices are durable
  facts. An active-Run Question is linked to its Run/Step/Action and must settle before that Action or Run.
- Choice Questions allow a custom-text `Other` answer by default unless the caller explicitly disables it.
  Committed Question input and output preserve every prompt, option, selected option ID, custom answer, and skip
  result so replay can render the confirmed interaction without relying on transient panel state.
- Accepting a Formal Plan atomically switches to Agent and starts exactly one implementation Run whose
  conversation history is the accepted document, not the planning discussion.
- The Executor input envelope remains machine context. Human-facing TUI projection renders the bound Formal
  Plan Markdown directly rather than presenting that generated envelope as a pasted user message.
- Before Plan Review can be settled, the timeline projects the complete Formal Plan with the same
  200-rendered-line bound and immutable local path used for Executor presentation; review choices must not hide
  the document being accepted.
- Complex Agent work may create a separate Work Plan through `update_plan`. Work Plan status is navigation only,
  never completion evidence, and does not schedule Runs.
- Qi assigns Work Plan and Work item IDs on first creation. Model-supplied item IDs are discarded on create;
  later updates may use only IDs returned by a successful prior `update_plan` result.
- Pre-Formal-Plan item revisions retain their historical item-per-Run behavior: later items require a durable
  `continue | stop | return_to_plan` choice. Terminal Runs are never resumed.
- At most one top-level Run is non-terminal.

## ADR-0013: keep interaction, activation, and product language separate

- Ask/Plan/Agent controls the current interaction surface.
- Turn-, goal-, time-, and event-based policies control how Runs start and continue.
- 同行、追寻、守望 are product projections, not Kernel authority enums.
- Effective authority is always the intersection of the launch lease and every applicable narrowing policy.
- Questions explicitly belong either to an active Run or to Session control between Runs.

## ADR-0014: preserve Session compatibility through explicit migrations

- Existing event types, ordering, identity links, and terminal outcomes keep their original meaning.
- Current SQLite databases are format generation 1; missing format metadata means generation 1.
- Additive event variants or optional fields with deterministic replay defaults are preferred.
- An incompatible change requires a new decision, explicit generation, preflight, restart-safe migration or
  side-by-side conversion, old-history/crash tests, backup instructions, and downgrade policy.
- Unsupported future generations or failed preflight leave the source unchanged and block writable startup.
- Migrations never manufacture evidence or semantically rewrite old facts.

## ADR-0015: separate project policy from Session mount facts

- Effective launch authority resolves as CLI flags over `$QI_HOME/projects/<project-id>/policy.toml` over
  `$QI_HOME/config.toml` over built-ins.
- Extra directories are read-only mounts addressed as `mount:<id>/...`; writes stay in the primary Workspace.
- Mounts are human-granted, reject filesystem roots and unsafe aliases, and never imply shell authority.
- Project policy determines future access. Session mount events record what a Session could see; they do not grant
  access when replayed.
- Persistent changes settle policy first and audit events second; startup reconciles any interrupted settlement.
- External TOML edits take effect on launch/relaunch, not silently during an active Runtime.
- Workspace `.qi` declarations never participate in capability precedence and cannot widen project policy.

## ADR-0016: keep execution local and Web read-only

- The `qi` process embeds the Kernel, Loop, providers, tools, policy, store, and human control surface.
- It is the only current interactive execution owner for an active Session.
- SQLite and Artifacts are durable local state, not an inter-process command bus.
- Web may inspect projects, history, and committed SSE; it cannot execute tools, answer Questions, or grant
  authority.
- Public TypeScript packages are embedding surfaces, but they do not create a second Runtime or bypass lower
  boundaries.

A daemon or writable remote control plane requires a separate decision covering single-writer ownership,
authentication, credentials, backpressure, upgrades, and orphaned-effect recovery.

## ADR-0017: bound TUI transcript work

- Paints are classified by visible projection impact; provisional/chrome changes do not rebuild settled history.
- Provisional output occupies one bounded live region; model reasoning uses a three-display-line tail there.
- Settled Runs and Steps reuse width/state-keyed formatting caches.
- Active Runs show a bounded recent-Step window; older Steps fold reversibly.
- A Formal Plan remains complete in review and Executor context, but both TUI projections render at most 200
  terminal lines and always name the immutable local document path. Longer plans also end with a Collapsed
  notice; the transcript does not add a second expansion state for content that can be opened directly.
- Presentation thresholds remain local UI policy, not Session-format semantics.
- Denied and other distinct Action settlements remain immediately visible.

## ADR-0018: publish a modular open-source Runtime

- The root stays `private: true`; independently consumable `packages/*` workspaces are public.
- `@civaapple/qi-agent` is the default-deny embedding façade over ordinary Runtime boundaries.
- `@civaapple/qi-tui` contains reusable Qi-specific terminal projections; `apps/cli` owns application
  composition.
- CLI package: `@civaapple/qi`; installed executable: `qi`.
- Coordinated public packages are `qi-protocol`, `qi-ai`, `qi-agent`, `qi-node`, `qi-tui`, and the `qi` CLI.
  Cohesive modules use controlled subpath exports rather than additional publication units.
- Canonical repository: `https://github.com/civaapple-alt/qi`; license: MIT.
- Initial versions are coordinated and public API changes require isolated JavaScript/TypeScript consumer evidence.
- Registry identity, source openness, and authorization to publish are separate gates.

## ADR-0019: make self-understanding read-only and governed

- `@civaapple/qi-agent/extensions` owns a versioned self model for identity, packages, invariants, decisions,
  verification, and known gaps.
- The model links to canonical sources and is checked against the workspace graph.
- Introspection contributes bounded context only; it cannot grant authority, alter policy, publish, or promote
  maturity.
- Self-improvement uses the ordinary Agent loop, capability checks, Effect Journal, tests, and human release
  decisions.
- Deterministic checks can prove structural claims. Product taste, governance, security policy, and semantic
  success remain human-owned.

## ADR-0020: use Qi as the only product and persistence namespace

- The product name is `Qi / 栖`; user-facing output and public TypeScript identifiers use `Qi`.
- Environment variables use the `QI_*` prefix.
- Machine-private configuration, credentials, packages, resources, and project state live under `$QI_HOME`
  (default `~/.qi`). Workspace `.qi` contains only allowlisted, versionable declarations and package locks.
- The Session database is `qi.sqlite` and the verification manifest is `qi.verify.json`.
- Runtime actor IDs, resource names, MIME vendor identifiers, introspection tools, and machine-readable evidence
  use the `qi` namespace.
- The private monorepo package is `qi-monorepo`; application scripts use the `qi:*` prefix.
- Qi 0.6 uses layout generation 2 and provides no automatic 0.5 data migration. Unsupported non-empty layouts
  fail without deletion and instruct the user to back up/clear the directory or choose a new `QI_HOME`.
- Event schema generation remains unchanged. Previously written actor/source strings are historical data and are
  never rewritten during replay; all new facts use the Qi identity.

## ADR-0021: bind a codeact tool and a guided verify setup without widening authority

- The `codeact` tool shares the existing `execute` capability toggle rather than introducing a new grant; it gives
  the model only a network-off, read-only-root container isolate whose nested calls still route through
  `ControlledToolClient`. It is registered only when a container runtime (`docker` or `podman`) actually responds
  to a probe; an unavailable runtime never silently degrades to a fake success.
- `ContainerProgramSandbox` accepts inline program source as an alternative to a program file path. The sandbox
  creates and removes its own staging directory in both cases, so a caller never manages an ad hoc temp-file
  location itself.
- Nested `codeact` tool calls are capped to the Tool Registry's currently registered catalog minus `codeact` and
  `delegate`, independent of what the outer subject's capability leases would otherwise authorize. This blocks
  sandbox self-recursion and delegation chaining regardless of how broad the outer grants are.
- Verification profiles remain declared, frozen, single-argv commands; nothing about guided setup allows
  shell-interpreted or multi-command input, in or out of the wizard.
- Guided verify setup (`/verify`) is an explicit, human-confirmed action, not a hook automatically triggered by
  enabling the `verify` capability. Scanning `package.json`, `pom.xml`, `AGENTS.md`, and `README.md` only proposes
  candidates; nothing is written to `.qi/qi.verify.json` without an explicit Apply, and unresolvable executables
  stay unselectable.
- The wizard writes through the same manifest schema, atomic write, and `loadVerificationProfiles` validation as
  the pre-existing automatic inference path, so a hand-picked manifest is exactly as trustworthy as an inferred
  one and the live `verify` tool is re-registered from the same code path either way.

## ADR-0022: centralize machine-private state under a generationed QI_HOME layout

- `@civaapple/qi-node/paths` is the only `$QI_HOME`, project identity, `--data`, database, and Web discovery
  implementation.
- Project IDs combine a readable Workspace basename with a SHA-256 prefix of the canonical realpath. Moving a
  Workspace creates a new identity unless `--data` explicitly redirects its private root.
- `$QI_HOME` and project-private roots cannot be filesystem roots, Workspace descendants, symlinks, junction
  traversals, or path-traversal targets.
- Project databases live in `state/`; credentials live only in `credentials/`; package content is immutable and
  content-addressed. Cache, staging, and tmp are rebuildable and never truth.
- Layout generation 2 is a clean 0.6 boundary. Qi neither migrates nor deletes a non-empty older layout.

## ADR-0023: allow declaration-only packages without granting authority

- `@civaapple/qi-agent/extensions` owns the manifest and contribution contract.
  `@civaapple/qi-node/extensions` owns acquisition, integrity, validation, content storage, and activation.
- npm sources require an exact version and registry integrity; Git requires an exact commit; local sources are
  content-digested. npm lifecycle scripts never execute.
- Workspace `.qi` permits only declarations and locks. Executable files, binary payloads, secrets, databases,
  Artifacts, caches, and unpacked third-party packages are rejected.
- Resource precedence is project-direct, project-packages, user-direct, user-packages, built-ins. Duplicate
  `(kind,id)` values in one layer fail instead of relying on directory order.
- Package registration never grants authority, accepts MCP bindings, expands a parent lease, bypasses Coordinator
  depth, or treats catalog metadata as trust.
- Qi 0.6 supports declaration-only packages. Executable plugins require a separate ADR for process isolation,
  restricted Host API, lifecycle, and crash settlement.

## ADR-0024: annotate restored Run history with projection facts, not tool transcripts

- Cross-Run conversation history still restores only the final assistant text of completed (or budget-handoff)
  Runs; tool transcripts remain durable Session evidence and do not masquerade as dialogue.
- Each restored assistant message appends a compact `<qi-run-facts>` footer with write/read Action counts and
  terminal reason from the Run projection.
- The footer exists so later Runs can distinguish verbal “already fixed” narration from durable write settlement
  without replaying Action payloads or inventing Runtime hard-blocks on free-form responses.
- Session extractors may emit a diagnostic `CLAIMED_MUTATION_WITHOUT_ACTIONS` signal when a responded Run claims
  mutation in prose with zero completed write Actions; that signal does not change Run completion semantics.

## ADR-0025: make memory scope explicit and user continuity opt-in

- New Memory claims use structured `session`, `project`, or `user` scopes. Runtime composition binds the concrete
  Session, project, and local-user IDs; a model may request a scope class but cannot name or widen its authority
  domain. Legacy string scopes remain replayable but do not participate in automatic cross-domain retrieval.
- Project and Session claims remain facts in the owning project's Session streams. Cross-project User claims live
  in one machine-private Continuity Session under `$QI_HOME/state`; this preserves append-only Session truth while
  allowing correction and forgetting from any Workspace.
- Promotion copies an accepted Project claim into a new, explicitly confirmed User claim with provenance. It never
  mutates the original claim's scope or makes Project memory visible elsewhere.
- The project and user SQLite Memory indexes are rebuildable projections. Event append commits before index
  application; stable operation identities and startup replay repair an interrupted projection without creating
  duplicate claims.
- The model may propose only provenance-backed candidates. Runtime auto-accept is limited to public,
  non-relational Session/Project claims backed by an exact user-input or completed-Action excerpt. User, private,
  secret, relational, correction, and promotion candidates require an explicit user actor.
- User claims may be marked `always` only by the user. At most four bounded claims are preferentially considered
  for each Run; Context Compiler omission remains explicit and Memory still grants no Tool authority.
- Memory capture and retrieval are enabled by default but configurable. Existing conversations are never mined
  automatically; only existing Memory events are replayed.
- Memory claim text remains plaintext inside machine-private SQLite files. Credential-like material is rejected at
  the durable boundary regardless of sensitivity or confirmation.

## Changing a decision

Update this document before implementing a cross-package behavioral change. State the pressure, the new boundary,
important rejected alternatives, compatibility impact, and required evidence. Keep chronological discussion in
the pull request; keep this file focused on the accepted result.
