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

- User Skills live under `~/.qi/skills`; Workspace Skills under `.qi/skills` shadow equal names.
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

- Model text and Action output may stream through a bounded, redacted, process-local activity channel.
- Consumers may coalesce or drop intermediate activity.
- Provisional activity is not completion evidence, Tool feedback, or replay state.
- Terminal model text, Action settlement, failure meaning, and Artifact references enter the Session stream once.

After a crash, only committed events and Artifacts are reconstructed.

## ADR-0006: represent long-lived processes as bounded ProcessTasks

- Finite commands settle inside an Action; servers and watchers use an explicit background Task operation.
- A ProcessTask has Session/Run/Step/Action ownership, a hard expiry, bounded logs, and a distinct lifecycle.
- Starting a Task requires separate background authority and completes only after process/log ownership exists.
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

- Provider profiles declare wire API, base URL, auth schemes, model window, and transport capabilities.
- Qi never probes failed endpoints to guess a wire API.
- Responses and Chat Completions adapters remain thin implementations of one portable model protocol.
- Credentials are sealed and resolved through a broker only at the provider boundary.
- Tokens, authorization headers, OAuth codes, and PKCE material never enter TOML, Session events, or Artifacts.
- `/login` owns interactive authentication; unauthenticated startup is allowed, but Runs fail closed.

## ADR-0011: make human control and Ask/Plan/Agent modes durable

- Session mode is durable `ask | plan | agent`; a Run freezes its mode when triggered.
- Ask is read-oriented. Plan adds managed Plan revisions and read-only depth-1 research delegation. Agent uses the
  granted launch upper bound.
- Mode narrows authority; it never creates authority.
- Questions, approval outcomes, Plan review, and next-Run choices are durable facts.
- Plan acceptance atomically switches to Agent and starts exactly one Run for the first incomplete item.
- Later items require a durable `continue | stop | return_to_plan` choice; terminal Runs are never resumed.
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

- Effective launch authority resolves as CLI flags over project TOML over user TOML.
- Extra directories are read-only mounts addressed as `mount:<id>/...`; writes stay in the primary Workspace.
- Mounts are human-granted, reject filesystem roots and unsafe aliases, and never imply shell authority.
- Project policy determines future access. Session mount events record what a Session could see; they do not grant
  access when replayed.
- Persistent changes settle policy first and audit events second; startup reconciles any interrupted settlement.
- External TOML edits take effect on launch/relaunch, not silently during an active Runtime.

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
- Provisional output occupies one bounded live region.
- Settled Runs and Steps reuse width/state-keyed formatting caches.
- Active Runs show a bounded recent-Step window; older Steps fold reversibly.
- Presentation thresholds remain local UI policy, not Session-format semantics.
- Denied and other distinct Action settlements remain immediately visible.

## ADR-0018: publish a modular open-source Runtime

- The root stays `private: true`; independently consumable `packages/*` workspaces are public.
- `@civaapple/qi-agent` is the default-deny embedding façade over ordinary Runtime boundaries.
- `@civaapple/qi-tui` contains reusable Qi-specific terminal projections; `apps/cli` owns application
  composition.
- CLI package: `@civaapple/qi`; installed executable: `qi`.
- Runtime packages: `@civaapple/qi-<workspace>`; Web application: private `@civaapple/qi-web`.
- Canonical repository: `https://github.com/civaapple-alt/qi`; license: MIT.
- Initial versions are coordinated and public API changes require isolated JavaScript/TypeScript consumer evidence.
- Registry identity, source openness, and authorization to publish are separate gates.

## ADR-0019: make self-understanding read-only and governed

- `@civaapple/qi-introspection` owns a versioned self model for identity, packages, invariants, decisions,
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
- User configuration and project data live under `~/.qi`; Workspace-private Skills and verification manifests
  live under `.qi`.
- The Session database is `qi.sqlite` and the verification manifest is `qi.verify.json`.
- Runtime actor IDs, resource names, MIME vendor identifiers, introspection tools, and machine-readable evidence
  use the `qi` namespace.
- The private monorepo package is `qi-monorepo`; application scripts use the `qi:*` prefix.
- This pre-release rename provides no legacy environment-variable or path fallback. Existing local data must be
  moved and renamed explicitly before reuse.
- Event schema generation remains unchanged. Previously written actor/source strings are historical data and are
  never rewritten during replay; all new facts use the Qi identity.

## Changing a decision

Update this document before implementing a cross-package behavioral change. State the pressure, the new boundary,
important rejected alternatives, compatibility impact, and required evidence. Keep chronological discussion in
the pull request; keep this file focused on the accepted result.
