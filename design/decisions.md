# Current architecture decisions

This document records Qi's current cross-package decisions. It intentionally describes the architecture
that contributors must preserve, rather than the chronological path used to reach it. Stable ADR identifiers
remain in headings so code, tests, and discussions can refer to a decision without depending on a directory of
historical records.

For package ownership and the end-to-end model, see [system-design.md](system-design.md). Package-local details
belong in `packages/*/README.md` and `packages/*/docs/`.

## ADR-0001: gate sensitive paths before content reaches the model

- Discovery tools (`list`, `tree`, `find`) may expose sensitive file **paths** as metadata so the operator and
  model can locate them. They must not return file bodies for those paths.
- Content-exposing file tools (`read`, content `search`/`grep`, `edit`, `write`, and equivalent) classify the
  target path before execute. Unclassified ordinary Workspace files may round-trip as raw text so precise `edit`
  stays exact.
- Paths classified as sensitive require an explicit human grant before any file body enters tool settlement or
  model feedback. Grants are durable project configuration plus Session audit facts, and rehydrate into runtime
  allowlists for later Actions.
- Denial fails closed before the executor reads bytes (`SENSITIVE_PATH_GRANT_REQUIRED`), mirroring
  `PATH_GRANT_REQUIRED` for outside-Workspace mounts. Do not hold a completed Action payload for post-read
  approval.
- Opaque credential handles remain the preferred transport for provider and execution-side secrets.
- Last-resort content redaction, when retained, targets only extremely high-confidence literal shapes (for
  example provider API tokens and PEM private-key blocks). It must not rewrite source-code assignment forms
  such as `password: &str` or `jwt_secret: env::var(...)`, and it is not a substitute for path grants.

Previously persisted Session databases are not silently rewritten when this policy changes.

## ADR-0002: separate model window, output reserve, and working context

- Provider/model window, next-response reserve, and prompt budget are distinct values.
- The adapter and Turn Loop use the same resolved limits.
- `context.compiled` may retain bounded aggregate ContextBlock accounting by kind: included/omitted counts and
  estimated tokens. These replayable operator diagnostics never contain block content, source values, retention
  reasons, or provider payloads; conversation and advertised Tool-schema cost remain a separate non-block subtotal.
- Settled tool exchanges may be compacted into deterministic summaries plus Artifact references.
- Session events and Artifacts remain complete durable evidence; compaction changes only future model input.
- If required context still cannot fit, the Run parks with a budget outcome.

## ADR-0003: use freshness-checked precise file mutation

- `read`, `edit`, `write`, `move`, and `remove` remain separate operations.
- `read` may return a bounded 1-based line range, but its size and freshness hash always describe the complete
  file so a partial observation cannot weaken mutation freshness.
- `edit` requires a previously observed whole-file content hash and one or more targeted replacements in a single
  call (`edits[]`). Every `oldText` is matched against the same original snapshot, then applied atomically;
  overlapping or nested hunks fail closed with `EDIT_TARGETS_OVERLAP`. Prefer one multi-hunk call over several
  same-file `edit` Actions in one Step.
- Matching tries exact LF-normalized substring first, then a limited fuzzy ladder (line trailing whitespace,
  NFKC, smart quotes/dashes, and exotic spaces). Fuzzy hits rewrite only touched line blocks so untouched
  original bytes and an existing UTF-8 BOM stay preserved. Indentation, approximate blocks, and other whitespace
  remain exact. `replaceAll` is allowed only for a single-hunk call.
- Missing, ambiguous, overlapping, stale, and no-op edits fail before mutation.
- Consecutive `edit` calls to the same resource in one Step remain a fallback: the Loop may rebase only from the
  chain's original digest to the latest successfully settled digest, re-inspects before authority, and records
  `action.freshness.rebased`. It still does not rewrite `oldText`. Mixed mutations and unproven digest ancestry
  fail closed.
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
- For providers that require thinking-mode tool continuation, the Turn Loop may echo committed reasoning into
  the same-Run portable `ModelMessage` history (as a non-evidence reasoning part) so adapters can round-trip it.
  Cross-Run conversation restore does not revive that CoT into long-term model memory, and reasoning never
  becomes Goal or verification evidence.

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

- Provider profiles declare a default wire API, base URL, auth schemes, transport capabilities, and
  model-specific context windows, thinking modes, or wire-API overrides where those differ within one provider.
- A model entry may override the profile wire API (for example DeepSeek `deepseek-v4-flash` uses Responses while
  `deepseek-v4-pro` stays on Chat Completions until the vendor supports Responses). Selection remains explicit
  from the profile catalog; Qi never probes failed endpoints to guess a wire API.
- Responses and Chat Completions adapters remain thin implementations of one portable model protocol.
- Provider-specific thinking fields are derived deterministically from the selected model profile and explicit
  operator configuration; unknown effort values fail before network execution. Portable effort levels are
  `low` / `medium` / `high` / `max` / `none`; catalogs advertise only the levels they support, and unsupported
  selections fall back to the model `defaultEffort` on the wire. Volcengine Agent Plan Responses enables
  deep thinking with `thinking: { type: "enabled" }` plus `reasoning: { effort }` (see vendor Responses docs).
- Qi-managed provider credentials are sealed and resolved through a broker only at the provider boundary.
- Provider tokens, provider authorization headers, OAuth codes, PKCE material, and other Qi-managed authentication
  secrets never enter TOML, Session events, Artifacts, or model context.
- Ordinary Tool content that has passed capability, path, and sensitive-path authorization round-trips exactly,
  including source, configuration, or request examples containing `Authorization: Bearer`. A matching string
  shape does not make Workspace content a Qi-managed credential; ADR-0001 controls whether sensitive file bodies
  may be read at all.
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
- Clarification Questions via in-Run `ask_question` are available in Plan and Agent (not Ask). Asking narrows
  nothing about write/execute authority; mode still only narrows leases. Freeform assistant prose that ends the
  Turn and waits for the next user input remains an equally valid clarification channel when the tool is not
  advertised. Approval outcomes, Plan review, and legacy next-Run choices stay durable Session-control facts.
  An active-Run Question is linked to its Run/Step/Action and must settle before that Action or Run.
  `plan_document` and Formal Plan drafting remain Plan-only.
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
- A Formal Plan drafting or revision Run cannot complete merely because `plan_document` was called. It must
  complete a `write`-effect `plan_document create/edit` Action that records a new immutable revision in that Run.
  `plan_document read` supplies current Markdown and SHA for a later edit, but never satisfies the drafting
  completion gate or creates a new review.
- Complex multi-step work in Plan or Agent (not Ask) may use `update_plan` Work Plans for focus. Work Plan
  status is navigation only, never completion evidence, and does not schedule Runs. A revision is a full item
  snapshot: status, rewritten step text, added items, or dropped items as the work evolves. After a slice
  finishes (or the problem changes), omitting `workPlanId` and every `workItemId` creates a fresh Work Plan;
  long Goals commonly need successive plans. Formal Plan (`plan_document`) remains a separate Plan-only design
  artifact and is never a Todo list.
- Qi assigns Work Plan and Work item IDs on first creation. Omitting `workPlanId` with no `workItemId` values
  creates a new plan. Omitting `workPlanId` while supplying only `workItemId` values that belong to
  `currentWorkPlanId` continues that plan. Later updates may use only IDs returned by a successful prior
  `update_plan` result (or the Runtime Work Plan navigation ContextBlock from ADR-0032).
- Pre-Formal-Plan item revisions retain their historical item-per-Run behavior: later items require a durable
  `continue | stop | return_to_plan` choice. Terminal Runs are never resumed.
- At most one top-level Run is non-terminal.

## ADR-0013: keep interaction, activation, and product language separate

- Ask/Plan/Agent controls the current interaction surface.
- Turn-, goal-, time-, and event-based policies control how Runs start and continue.
- 同行、追寻、守望 are product projections, not Kernel authority enums.
- Effective authority is always the intersection of the launch lease and every applicable narrowing policy.
- Questions explicitly belong either to an active Run or to Session control between Runs.

## ADR-0014: version pre-stable persistence boundaries explicitly

- Qi is still in active development. Before a stable compatibility baseline is declared, source milestones do
  not promise automatic migration or indefinite replay of Sessions and private layouts from earlier milestones.
- Additive changes remain preferable when they are simple, but preserving every historical development format is
  not a release gate.
- Persisted layers version their own boundaries explicitly: Session events/databases, rebuildable indexes,
  `$QI_HOME`, and project/Session directory layouts do not share one ambiguous generation number.
- An incompatible change increments the affected generation or version and preflights it before writable startup.
  Unsupported data fails closed before mutation.
- Rejection leaves the source unchanged: Qi does not delete, partially convert, manufacture evidence, or
  reinterpret old facts. Operator guidance may require backup, reset, or a new `QI_HOME` / data root; it does not
  imply automatic migration or downgrade support.
- Before the first stable compatibility commitment, a new ADR must define which generations become a long-term
  replay baseline and what migration and downgrade policy they receive.

## ADR-0015: separate project policy from Session mount facts

- Effective launch authority resolves as CLI flags over `$QI_HOME/projects/<project-id>/policy.toml` over
  `$QI_HOME/config.toml` over built-ins for **capabilities**, mounts, and related project policy.
- **Shell profiles** (`direct` / `pwsh` / `cmd` / `bash`) are user-global under `$QI_HOME/config.toml` only.
  Project `policy.toml` `[shell]` is ignored for effective authority. `/shell` (and Settings → Shell) hot-applies
  allowed profiles without restarting the CLI, mirroring `/permissions` for capabilities.
- On first launch without `[shell]`, Qi probes platform-installed script profiles, writes
  `direct` plus each installed candidate into `$QI_HOME/config.toml`, and treats that file as source of truth.
- Extra directories are read-only mounts addressed as `mount:<id>/...`; writes stay in the primary Workspace.
- Mounts are human-granted, reject filesystem roots and unsafe aliases, and never imply shell authority.
- Project policy determines future access for capabilities/mounts. Session mount events record what a Session
  could see; they do not grant access when replayed.
- Persistent changes settle policy first and audit events second; startup reconciles any interrupted settlement.
- External TOML edits to project policy take effect on launch/relaunch, not silently during an active Runtime.
  Live `/shell` and `/permissions` are the in-session apply paths for shell profiles and capabilities.
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
- The richer hierarchy, density, attention, and long-Session contract is defined by ADR-0027.
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
- Layout generation 2 was introduced in the 0.7.0 source milestone as a clean development boundary from 0.5 data.
  Unsupported non-empty layouts fail without deletion and instruct the user to back up, reset, or choose a new
  `QI_HOME`.
- Product or layout version changes do not rewrite actor/source strings inside a supported Session generation;
  new facts use the Qi identity.

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
- Project-level indexes live in project `state/`; Session-owned event databases, Effect Journals, Artifacts,
  Plans, and Tasks live under the self-contained Session directories defined by ADR-0030. Credentials live only
  in `credentials/`; package content is immutable and content-addressed. Cache, staging, and tmp are rebuildable
  and never truth.
- Layout generation 2 was introduced in 0.7.0 as a development clean break. Under ADR-0014, Qi neither migrates
  nor deletes an unsupported non-empty older layout.

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
- The 0.7.0 source milestone introduced declaration-only packages. Executable plugins require a separate ADR for
  process isolation, restricted Host API, lifecycle, and crash settlement.

## ADR-0024: annotate restored Run history with projection facts, not tool transcripts

- Cross-Run conversation history restores only the final assistant text of completed, budget-handoff, and
  interrupted (`failed` / `cancelled` / non-budget `parked`) user Runs when a restorable narrative or image
  exception applies; tool transcripts remain durable Session evidence and do not masquerade as dialogue.
  See ADR-0032 for the interrupted-run and omission-hint allowlist.
- Restored assistant messages remain only assistant-authored narrative. A separate Runtime-owned system
  ContextBlock may label each selected restored turn with only a coarse write-settlement class:
  `none | completed | unsuccessful | mixed`. It exposes no durable Run/Action IDs, read counts, write counts,
  timestamps, paths, or tool payloads. Coarse terminal status/reason may appear only inside the interrupted-run
  wrappers defined by ADR-0032.
- The minimal disclosure lets later Runs distinguish verbal “already fixed” narration from the existence of a
  settled write Action. It is not verification evidence and does not describe what changed. Reserved legacy
  `<qi-run-facts>` tags are removed from restored narrative and committed model responses so model imitation
  cannot multiply or fabricate Session metadata.
- Session extractors may emit a diagnostic `CLAIMED_MUTATION_WITHOUT_ACTIONS` signal when a responded Run claims
  mutation in prose with zero completed write Actions, including Formal Plan persistence claims. They may also
  flag legacy reserved Run-fact tags found in committed model output. These signals do not change Run completion
  semantics.

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

## ADR-0026: treat Runtime-to-model disclosure as a least-information boundary

Pressure: the durable Session stream contains IDs, lifecycle milestones, authority decisions, counts, paths,
timestamps, and settlement details useful to replay and operators. Copying those facts into ordinary model context
increases prompt influence, teaches models to imitate internal syntax, and exposes implementation topology without
improving the requested task.

- The event stream and projections are the complete Runtime truth. Model context is a purpose-built disclosure
  view, never a mirror of that truth. Runtime-owned model-visible fields are deny-by-default and explicitly
  allowlisted per use case.
- Every Runtime-owned ContextBlock must state one concrete model decision it supports, use the least precise
  semantic value sufficient for that decision, remain bounded, and omit internal identifiers, exact counts,
  timestamps, paths, provider details, authority traces, and unrelated lifecycle state unless one is strictly
  necessary for the stated purpose.
- Prefer coarse predicates or enums over telemetry. Correlate disclosure to the model's already-visible material
  with local ordinals, not durable Session/Run/Step/Action IDs. For restored history, ADR-0024's write-settlement
  class plus the ADR-0032 allowlist (interrupted wrappers, omission count, Work Plan navigation handles) are the
  entire automatic disclosure contract.
- Runtime disclosure never grants capability, proves task completion, enters the Evidence Ledger, or makes model
  narration authoritative. Detailed Runtime facts require an explicit bounded read/introspection Action and its
  ordinary capability decision; metadata already present in model context cannot widen that query.
- Required Runtime ContextBlocks are reserved for safety or control invariants. Task-helpful diagnostics are
  optional and omission-visible. Payloads stay out of `context.compiled`; that event records selected/omitted
  block identities, budgets, and bounded aggregate kind/count/token accounting only.
- The CLI assembles one deterministic, sectioned model-context recipe per Run. Runtime safety, frozen mode,
  coarse capability facts, and probed host facts are required `system` control blocks. Root Workspace
  instructions, accepted Memory, and Skill metadata are separately delimited `user` context: they cannot grant
  authority, override Runtime policy, or become completion evidence. Memory claims are never injected as naked
  `system` instructions.
- A valid root `AGENTS.md` remains optional in Ask, but is required when Plan designs Workspace work or an Agent
  Run has Workspace Write authority. A present symlink, non-file, or file above the bounded size limit fails
  closed for those Runs; an absent file does not invent a repository contract. Read-only mounts disclose only
  logical `mount:<id>` handles and mode, never host paths.
- Context allocation reserves current input, required control/policy blocks, and the advertised Tool schemas
  before selecting whole restored turns and optional Workspace/Memory/Skill blocks. One deterministic estimator
  applies to all text and schema costs; provider/model-specific estimators may narrow the conservative Unicode
  fallback. A history-omission hint is optional under pressure, while omitted Run identities remain
  operator-visible only in bounded `context.compiled` metadata.
- Rejected alternatives: replaying Action/tool transcripts or raw event JSON; embedding machine tags in assistant
  prose; automatically exposing IDs and exact counters “for debugging”; and withholding all settlement indication,
  which lets restored verbal mutation claims influence later Runs with no counter-signal.
- Compatibility and evidence: legacy reserved tags remain readable in old Session events but are stripped from
  new model context/output and diagnosed by extraction. Tests must prove the allowlisted disclosure shape, absence
  of internal IDs/counters, deterministic omission/accounting, and that details remain available only through
  explicit introspection.

## ADR-0027: project one bounded interaction timeline with protected human attention

Pressure: a long-lived Session can contain hundreds of Runs and thousands of committed Actions plus high-rate
provisional output. Rendering every fact with equal visual weight obscures user intent, changes, verification,
risks, and handoffs; replaying the complete stream on every append or paint also makes long Sessions progressively
less responsive.

- The terminal has three regions: a committed同行 timeline, one bounded provisional Working region, and a local
  control region. Only committed Session facts enter the timeline. Provisional model/tool/task output remains
  redacted, bounded, and non-evidentiary.
- Timeline density is local presentation policy: `compact | standard | diagnostic`, default `standard`. It may be
  persisted as a user preference or overridden for one Session without writing a Session event.
- Consecutive known read-only discovery Actions in one Step may project as one reversible activity group. Every
  durable Action and distinct settlement remains inspectable; failed, denied, cancelled, indeterminate, parked,
  and lost outcomes cannot be hidden by a successful aggregate.
- The standard timeline prioritizes user messages, committed Qi replies, mutations, verification, decisions,
  risks, and handoffs. Settled reasoning becomes a one-line expandable record; successful finite process and
  discovery detail collapses; exceptions retain bounded evidence.
- The main transcript uses a density-specific recent-Run window plus a rendered-line ceiling. Older Runs remain
  available through a searchable, observational History Center. Selection never changes the executing Run.
- Attention controls are focus-safe. A blocking gate may open automatically only when the composer is empty and
  no follow-up edit is active; otherwise it becomes a persistent attention notice opened explicitly by the user.
- UI timing never invents Runtime state. Elapsed/still-running labels are local projections of committed start
  time plus the current clock. Qi does not label a later Action as a retry without a durable relation and never
  recommends automatic retry for an indeterminate effect.
- Append validation and hot presentation use incremental in-process projections. Cold start, cache invalidation,
  version mismatch, and restart still rebuild from the append-only stream; no projection cache is persisted or
  promoted to truth.
- Compatibility: Session schemas and database formats do not change. `TuiPresenter.update()` remains the full
  resynchronization API; additive incremental and density APIs preserve existing embedders. Non-TTY output uses
  the same bounded standard projection without animation.
- Required evidence covers replay parity after incremental append, rollback/cache invalidation, all density and
  settlement states, focus protection, CJK/narrow/no-color rendering, bounded caches, and a fixed 500-Run stress
  fixture. Rejected alternatives are an unbounded transcript, a second UI state machine, inferred retries,
  modal focus stealing, and hiding all tool facts behind an opaque summary.

## ADR-0028: persist ordered media references and materialize provider payloads late

Pressure: design, frontend, document, and reporting work frequently starts with screenshots or reference images.
Passing an image URL directly to a provider delegates network authority, while persisting data URLs inflates the
event stream and can leak binary content into logs, redaction, and context accounting.

- `run.triggered` may carry an ordered sequence of text and image parts in addition to the legacy human-readable
  `input` string. Image parts contain only bounded provenance, dimensions, media types, byte counts, and
  content-addressed original/prepared Artifact references. Session events never contain image bytes or data URLs.
- Node owns image acquisition and preprocessing. Clipboard bytes, Network-authorized public URL downloads, and
  Workspace/mount file paths (including absolute paths rewritten onto an authorized root) pass the same MIME,
  magic-byte, decode-size, pixel-count, dimension, count, and aggregate-byte checks before a Run is committed.
  Provider-side URL fetching is not an ingestion path. Path ingestion never widens authority beyond the primary
  Workspace and currently authorized read-only mounts.
- Original and prepared images are retained as project-private Artifacts. The prepared image is the default model
  view; an explicitly authorized read-only image Action may derive a bounded crop from an original attachment.
  Skills, prompts, and provider capabilities do not grant that Action authority.
- The Agent restores ordered image parts from durable Run history while they fit the Context Compiler budget.
  Missing or digest-invalid Artifacts become an explicit image-unavailable text part. They never become fabricated
  visual context.
- Artifact references are recursively verified and converted to ephemeral data URLs only at the final provider
  boundary and only after sensitive-text redaction. Provider payload bytes therefore do not enter Session truth,
  Artifact metadata, telemetry, or text redaction.
- Model profiles declare input modalities. A request containing an image fails before provider I/O unless the
  selected profile enables image input. OpenAI-compatible endpoints deny image input by default and require an
  explicit operator opt-in.
- Text and image parts share one context budget. Image cost uses a conservative dimension/tile estimate rather
  than the serialized base64 length. Tool-result images remain associated with their tool call while adapters may
  emit a synthetic user media message when required by a provider wire format.
- Rejected alternatives are provider-side URL fetching, persisting image bytes or data URLs in Session events,
  treating model modality support as read authority, and adding video before its protocol and budget boundaries
  are defined.
- Compatibility is additive: old `run.triggered` events synthesize one text part from `input`, string prompt APIs
  remain valid, and the SQLite generation does not change. Version one exposes images only; video stays a future
  protocol extension even when a provider advertises video support.
- Required evidence covers old/new replay, absence of base64 in events and SQLite, preprocessing and adversarial
  decode limits, public-network policy, model capability denial before I/O, adapter request shapes, late Artifact
  materialization, missing-Artifact recovery, image Action authorization, ordered TTY composition, and queued
  follow-ups.

## ADR-0029: separate Workspace mutation from private Artifact persistence

Pressure: Artifact storage and Workspace file tools both use a durable `write` effect, but they change different
worlds. A model without Workspace Write authority can still persist diagnostic or handoff Artifacts. Treating those
Actions as Workspace writes makes implementation progress, restored-history settlement, and operator projections
look stronger than the underlying facts. A single coarse `artifact-store:local` resource also makes independent
content-addressed puts conflict inside one Step.

- Artifact persistence is machine-private Runtime state. It never creates, edits, moves, or removes a Workspace
  file and cannot substantiate an implementation Todo or a claim that project code landed.
- The model-visible Artifact Tool and Agent-mode control block state this boundary explicitly. When the user's task
  requires Workspace mutation but Write authority is disabled, the Agent stops and directs the human to the
  permission control instead of substituting Artifacts.
- Content-addressed Artifact puts inspect a digest-scoped resource. Different digests may settle independently in
  one Step; the same digest keeps one resource identity for authorization, serialization, replay, and recovery.
- Bounded introspection preserves the legacy aggregate write counters for compatibility and adds separate
  Workspace, Artifact, and other-write counts. Operator surfaces prefer the separated categories and continue to
  label every count as diagnostic rather than Evidence.
- Work Plan state remains model-authored navigation, not a completion gate. A surface may warn when completed
  implementation Todos have no completed Workspace mutation or verification in the Run, but it does not rewrite
  the durable Work Plan.
- Rejected alternatives are counting every Artifact as a Workspace mutation, denying private diagnostic
  persistence whenever Workspace Write is disabled, and serializing all content-addressed puts through one
  coarse resource.
- Compatibility is additive: Session event schemas, effect names, database layout, and existing aggregate
  inspection fields remain valid. Artifact capability resources become digest-scoped, so application leases use
  the corresponding bounded wildcard.
- Required evidence covers Write-disabled Agent context, Artifact-vs-Workspace inspection counts, two distinct
  same-Step Artifact puts, same-digest resource identity, permission-safe Work Plan presentation, and replay of
  existing Sessions whose Artifact Actions used the legacy coarse resource.

## ADR-0030: make Session directories the movable persistence boundary

Pressure: project-wide event, Effect, Artifact, Plan, and ProcessTask stores make a Session impossible to archive
without copying selected rows and recursively discovering shared files. They also let stale Session projections
remain visible after an operator asks to reset a Workspace's conversational state.

- Each active Session owns one directory under `projects/<project>/sessions/<session-id>` containing its event
  database, Effect Journal, Artifacts, Formal Plans, and ProcessTask logs. Archived Sessions use the identical
  self-contained layout under `archives/<session-id>`.
- The append-only stream records `archive.requested`, `archived`, `restore.requested`, and `restored` lifecycle
  facts. Node owns verified, same-volume directory moves and a recoverable project operation journal; neither
  storage location nor an index silently substitutes for Session truth.
- Archive is denied unless Runs, Actions, Questions, Delegations, ProcessTasks, and Watchers are settled. Pending
  and archived Sessions reject ordinary events. Restore validates the archive manifest before making it active.
- Project Memory and Session catalogs remain rebuildable projections over active Session streams. User
  continuity, policy, installed packages, credentials, and caches are project- or user-owned and do not move.
- `/reset-workspace` archives the complete preflighted active set and creates a new Session. It is recoverable and
  reversible; it is not deletion.
- Project layout version 2 is an intentional development clean break under ADR-0014. A legacy shared-store layout
  is rejected before writable startup with backup, reset, or new-data-root guidance. Qi neither guesses ownership,
  migrates or downgrades that layout automatically, nor deletes old data.
- Rejected alternatives are an `archived` flag in one shared database, best-effort file copying, automatic
  cancellation of unsettled effects, and treating a rebuildable catalog as the lifecycle authority.
- Required evidence covers isolation, lifecycle denial, manifest validation, move interruption recovery,
  reset preflight atomicity, restore replay, protected-path enforcement, and active-only Memory rebuilding.

## ADR-0031: preserve composer drafts across local slash controls

Pressure: invoking a local control such as model selection cleared an already-written prompt, while `@`
completion lacked a consistently usable discovery path and had machine-dependent fallback behavior.

- A recognized slash command occupies the first logical editor line. Commands declare whether following text is
  preserved, consumed, or rejected. Completing a draft-preserving command at the start of existing text inserts
  a newline; the local control consumes only its first line and restores the suffix and cursor.
- `@` mentions resolve to validated Workspace-relative file or directory text. Completion is bounded, has one
  deterministic ignore/protected-path policy with or without `fd`, never crosses mounts or symlinks, and never
  injects file bytes into model input.
- Sealed provider credentials and model routing are separate. Model, supported reasoning effort, context limit,
  and compatible-endpoint image opt-in may be updated without exposing or re-entering a secret. Endpoint changes
  still require credential rebinding.
- Startup surfaces disclose the complete effective capability partition as enabled and disabled; the compact
  status line remains unchanged.
- Compatibility: these are local interaction and profile-routing changes; Session event and database generations
  do not change. Existing non-secret configuration remains valid subject to the selected model profile.
- Rejected alternatives are clearing the entire draft for every local command, submitting unvalidated mention
  paths, exposing or re-entering sealed credentials for a model-only change, and showing only enabled permissions.
- Required evidence covers draft/cursor preservation, mention validation and fallback parity, profile-bounded
  model changes without secret access, and capability display after all configuration precedence is applied.

## ADR-0032: bound automatic disclosure for consecutive Session Runs

Pressure: each continue is a new Run. Session truth retains Work Plans, Formal Plans, images, and Action
settlements, but automatic model context previously restored only completed/budget-handoff narrative (plus an
image-interrupted exception). Failed or parked continuations and unfinished Work Plans were easy to lose, while
replaying tool transcripts or Runtime telemetry would violate ADR-0024/0026.

- Automatic cross-Run dialogue still never includes tool transcripts, Action payloads, or Run/Step/Action IDs in
  model-visible prose.
- Restored history may include, in addition to completed and budget-handoff turns:
  - interrupted Runs with images (`<qi-interrupted-media-run>`), preserving Artifact-backed visual continuity;
  - interrupted Runs without images when a non-empty final assistant narrative exists (`<qi-interrupted-run>`),
    stating only coarse status/reason plus that narrative.
- When the history budget drops whole earlier turns, a Runtime ContextBlock may state only
  `olderTurnsOmitted=<N>` and point to explicit `qi_session_inspect` (`recovery` preferred). It must not list
  omitted Run IDs in model text; compile metadata may still record `history:omitted:<runId>` for operators.
- Plan and Agent Runs may receive a Runtime Work Plan navigation ContextBlock when `currentWorkPlanId` has
  unfinished items: allowlisted `workPlanId`, `revision`, and per-item `workItemId` / `step` / `status`, with an
  explicit navigation-not-evidence disclaimer. Ask Runs never receive it. Work Plan IDs are model-authored
  handles required to continue `update_plan`, not Runtime lifecycle telemetry.
- Formal Plan acceptance still starts an Executor with `historyBudgetTokens: 0` and the accepted Markdown
  envelope only. Planning conversation remains isolated (ADR-0011).
- Host environment, mode, skills, AGENTS.md, and memory ContextBlocks continue to regenerate each Run; prior
  system blocks and compacted within-Run tool exchanges are not copied forward.
- Compatibility is additive and changes only bounded context selection and projection. Existing Session event and
  database generations remain valid; absent interruption or Work Plan facts simply produce no new block.
- Rejected alternatives: auto-injecting full `recovery` projections; forging budget-handoff Steps on provider
  failure; restoring Plan-mode chat into Executors; replaying Action/tool transcripts; ranking image retention
  ahead of text inside a turn budget (deferred).
- Required evidence: interrupted narrative restoration without tool roles; media-interrupted preference over
  double wrappers; omission hint without Run IDs; unfinished Work Plan block shape; `update_plan` continue-current
  when `workPlanId` is omitted but known `wit_*` values are supplied; Formal Plan executor history stays empty.

## ADR-0033: Session-local Goal continuation for 追寻

Pressure: Goal, Evidence, and control receipts already exist as Session facts, but Runs were not bound to a
Goal contract. TurnLoop ended ordinary Runs as `completionKind: "response"`, so 追寻 could not continue across
bounded Runs without inventing a second truth source or turning one Run into an unbounded loop.

- A Goal remains a Session-owned completion contract (assertions, evidence requirements, budgets, stagnation,
  control receipts). It is not a Run, Work Plan, Formal Plan, Memory claim, or Watcher.
- `run.triggered` may freeze an optional `goalBinding: { goalId, contractVersion }`. Only an `active` Goal with a
  matching `contractVersion` may be bound. Terminal Goals (`complete` / `cancelled`) reject new bindings.
- `run.triggered.trigger` gains `"goal"` for explicit Goal continuation. `timer` / `event` remain Watcher
  awakenings and may also carry a Goal binding; they do not complete a Goal by themselves.
- TurnLoop still executes one bounded Run. A portable `settleGoalBoundTurn` helper (decide + apply) observes the
  settled Goal-bound Run and decides `complete` / `pause` / `block` / `await-continue` / `cancel`. Hosts must
  call it after every Goal-bound Run; omitting settlement leaves pause/block/complete unenforced. It never
  grants Action authority.
- Model stop or narrative “done” cannot complete a Goal. Verified Run completion and Goal `complete` require
  matching evaluations and Evidence Ledger entries (existing Kernel gates). Human Accept / Re-evaluate may
  record `human` evidence and `HumanEvaluator` outcomes (`pass` / `fail` / `unknown`) through the same ledger
  path; only `pass` with satisfied requirements can complete. Tool diffs, stdout, thinking, and Work Plan todos
  are diagnostic/navigation and never Evidence Ledger records. Formal Plan remains a separate `/plan` path and
  is never auto-created by Goal Continue.
- Budget exhaustion and stagnation park the Run and pause the Goal; `action.indeterminate` blocks the Goal and
  forbids automatic retry. Ordinary non-bound Turns may still run while a Goal is `paused`.
- Goal `attempts` default to the Session `maxSteps` value frozen at Goal creation. TurnLoop charges one attempt
  only after a Goal-bound Step that proposed a non-`read` Action; text-only and pure-read Steps are free.
  `maxSteps` remains the per-Run Step cap (every Step). Attempts are the cross-Continue Goal envelope.
- Loading or resuming an existing Session demotes an `active` Goal to `paused` (`Paused after Session resume`)
  so restart never silently continues 追寻; explicit Continue / Resume is required.
- Archive and `/reset-workspace` fail closed while any Goal is `active`, `paused`, or `blocked`.
- Compatibility is additive: older Sessions without `goalBinding` / `trigger: "goal"` replay unchanged.
- Rejected for this stage: Project-scoped Goal-owning Sessions, `goals.sqlite` as truth, default unlimited
  auto-continue, and a process daemon. Those remain explicit deferrals under ADR-0013 / the roadmap.
- Required evidence: binding validation; GoalContinuation after park/continue; no evidence ⇒ no complete;
  indeterminate ⇒ blocked; unfinished Goals block archive/reset; TurnLoop Goal ContextBlock without tool
  transcripts; resume demote; portable settle helper.

## Changing a decision

Update this document before implementing a cross-package behavioral change. State the pressure, the new boundary,
important rejected alternatives, compatibility impact, and required evidence. Keep chronological discussion in
the pull request; keep this file focused on the accepted result.
