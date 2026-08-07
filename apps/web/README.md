# `@civaapple/qi-web`

`@civaapple/qi-web` is Qi's local, read-only understanding surface. It opens the same durable SQLite Session world
as the TUI and presents two complementary projections:

- **Narrative** joins Run, Step, Action, authority, result, and diff events into a task-shaped execution story.
- **Audit** preserves the append-only event stream in sequence order for protocol-level inspection.

The application uses Node's native HTTP server and embedded HTML/CSS/JavaScript. It does not host another Runtime,
execute tools, mutate Session truth, or synthesize demo state. This single-execution-owner boundary is normative
in [ADR 0016](../../design/decisions.md#adr-0016-keep-execution-local-and-web-read-only); a writable Web control plane requires a separate
transport, authentication, and recovery decision.

## Start

Build the monorepo, then start the workbench. With no database argument it browses `$QI_HOME/projects`
(default `~/.qi/projects`):

```powershell
npm run build
npm run qi:web
```

Open `http://127.0.0.1:4317/`. Choose a project slug in the header, then switch Sessions. Deep links use
`?project=<slug>&session=ses_…&run=run_…`. First enter lists Sessions without replaying every stream; the
Narrative workbench loads first, and Audit pulls `/history` only when that mode is selected.

Explicit single-database mode remains available:

```powershell
npm run qi:web -- --db "%USERPROFILE%\.qi\projects\D-ai-project-qi\qi.sqlite"
# or: npm run qi:web -- --projects PATH
```

## Projection contract

- `GET /api/meta` reports `single` vs `projects` mode.
- `GET /api/projects` lists directories under the projects root that contain `qi.sqlite`.
- `GET /api/sessions?project=<slug>` (projects mode) lists Sessions by latest event time without full stream
  replay (catalog title from `session.created`). Depth-1 Subagent child Sessions (`Delegated: …` titles) are
  omitted from this picker; open them from the Subagent Tasks pane when needed.
- `GET /api/session/:id/workbench?project=<slug>` returns `view`, `narrative`, `memory`, and `eventCount` for
  first paint. The raw Audit stream is `GET /api/session/:id/history` and is loaded lazily when Audit mode is
  selected.
- Run labels prefer a short `displayTitle` (Accepted Formal Plans use `Accepted Plan · {title} · rev {n}`);
  raw `run.input` remains available and is not used as the sidebar or narrative title when a Formal Plan binding exists.
- A Step whose model requested Actions is not presented as fully complete until those Actions settle.
- Action lifecycle labels are derived by joining events on `actionId`; later events never invent missing authority
  or tool identity. Granted Actions surface `leaseId` and optional `policyTrace`; denied Actions surface the durable
  denial reason, a heuristic `denialCategory` (approval / user_deny / mode / path / lease / other), and policy
  trace when present. Web never invents Once/Session/Project approval choices — those are not Session facts.
- Failed Actions get a heuristic `failureCategory` (isolation / spawn / timeout / exit_nonzero / path_guard /
  sensitive_path / validation / other) from error codes and process streams. Process isolation signals (sandbox,
  EPERM, srt wrap failures) highlight as deterministic tool failures, not approval prompts. Each Action lists
  expected **guard layers** for its tool class (capability + path-guard; host children also show process-sandbox
  eligibility). That layer list is the dual-path product model, not a claim about the concrete sandbox backend.
- Session Continuity and Contract project durable **Session authority** from the Kernel view: `mode`
  (`ask|plan|agent`), read-only mounts (`workspace.mount.*`), and sensitive-path grants
  (`workspace.sensitive_path.*`).
- When present, **`run.environment.disclosed`** (ADR-0042) surfaces permission mode and process sandbox
  backend/strength/wraps on Run narrative headers and the Contract pane. Older Sessions without disclosure show
  an explicit empty state rather than inventing values.
- When present, **`authority.approval.decided`** renders a read-only approval card (Once / Session / Project,
  source interactive|memory|no-gate|policy-deny). Web never answers approvals.
- Audit mode enriches `authority.*` (including approval decisions), `run.environment.disclosed`,
  `session.mode.changed`, `workspace.mount.*`, and `workspace.sensitive_path.*`. Live SSE reloads on those types.
- Committed `step.model.reasoning` projects as a collapsible Thinking block (default ~3 lines). It is narrative-only
  and is not Evidence.
- Context omissions are labeled by projected category (for example an omitted history Run) instead of showing
  only an unexplained count.
- Explicit Skill activations are projected as bounded `name`/`scope` metadata on each Run. Narrative and sidebar
  render that metadata separately from the original task; Skill instruction bodies are not exposed by the Web UI.
- Model-initiated `skill` Tool calls are projected separately with bounded operation/name/status metadata. Skill
  `load` results never expose instruction bodies, and a failed Skill call that still yields a Run response is labeled
  as a fallback rather than an unqualified Skill success.
- `update_plan`, `ask_question`, `read_image`, process tools (`shell`/`script`/`verify`), and file mutations
  (`edit`/`write`/`move`/`remove`) use specialized narrative cards keyed by tool name (not Session mode), so
  Plan-mode Work Todos and Agent-mode clarification Questions render the same cards; generic JSON Tool result
  remains under a details fold. `read_image` targets prefer `image #N · source` over raw `artifact://` refs, and
  Run headers list Session image attachments. Web remains read-only and does not answer in-Run Questions.
- Failed `git` Actions project the full request on the target line (`git status · ref HEAD`,
  `git diff · maxCount 5`) and prepend that command to the result summary with the validation message; Tool
  result `details.command` remains available under the fold.
- Contract effect labels distinguish machine-private Artifact writes from Workspace writes. A completed Work Plan
  item without a completed Workspace mutation or verification Action is shown with a warning; Todo state alone is
  navigation, not mutation or Goal evidence. Contract binds `currentWorkPlanId` (successive Work Plans switch it).
- Action results, file diffs, and Git workspace-change diffs are diagnostics. They are not called Evidence Ledger
  records unless `evidence.recorded` exists.
- ProcessTasks are rendered from the Session's durable task projection independently of Run narrative folding;
  running servers and watchers therefore remain visible after their originating Run completes.
- Subagent Tasks (depth-1 `delegation.*` on the selected Run) appear in a dedicated inspector pane with status
  (including `timed_out`) and an Open-child control that loads the child Session read-only. Live updates follow
  `delegation.created` / `delegation.returned`. Web does not start, stop, or steer Subagents.
- Missing Goal, control receipt, evidence, or accepted memory is an explicit, explanatory empty state. When a
  Formal Plan or Work Plan is bound, the Contract pane surfaces that binding instead of leading with “No formal
  Goal”. The Web surface never fabricates those contracts from conversational behavior. Goal Contract cards
  show Evidence Ledger gap tags (`ledger-empty` / `ledger-gap`, per-assertion satisfied/partial/open); Knowledge
  separates Evidence Ledger cards from diagnostic Action results. Web remains read-only for Goal control.
- Projects mode reads the project Memory projection plus `$QI_HOME/state/memory.sqlite` read-only and shows
  Session/Project/User scope, provenance links, lifecycle, activation, and the exact `memory:<id>` blocks included
  or omitted by each committed `context.compiled`. Single-database mode reports that the User index is
  unavailable instead of implying an empty global history.

The raw history and committed SSE endpoints remain available for consumers that need protocol events directly.

## Change guide

Keep durable behavior in `packages/*`; Web-specific derivation belongs in `src/projection.ts`, and rendering belongs
in `src/assets.ts`. New event types must remain visible in Audit even before a richer Narrative renderer exists.
Add projection tests for joins and semantic labels, API tests for response compatibility, and browser acceptance for
navigation or layout changes.

Executable evidence: [`../../tests/web-workbench.test.mjs`](../../tests/web-workbench.test.mjs),
[`../../tests/web-projects.test.mjs`](../../tests/web-projects.test.mjs).
