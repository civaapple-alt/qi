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
`?project=<slug>&session=ses_…&run=run_…`.

Explicit single-database mode remains available:

```powershell
npm run qi:web -- --db "%USERPROFILE%\.qi\projects\D-ai-project-qi\qi.sqlite"
# or: npm run qi:web -- --projects PATH
```

## Projection contract

- `GET /api/meta` reports `single` vs `projects` mode.
- `GET /api/projects` lists directories under the projects root that contain `qi.sqlite`.
- `GET /api/sessions?project=<slug>` (projects mode) and `GET /api/session/:id/workbench?project=<slug>` open one
  project database; Sessions are ordered by latest event time.
- Run labels prefer a short `displayTitle` (Accepted Formal Plans use `Accepted Plan · {title} · rev {n}`);
  raw `run.input` remains available and is not used as the sidebar or narrative title when a Formal Plan binding exists.
- A Step whose model requested Actions is not presented as fully complete until those Actions settle.
- Action lifecycle labels are derived by joining events on `actionId`; later events never invent missing authority
  or tool identity.
- Committed `step.model.reasoning` projects as a collapsible Thinking block (default ~3 lines). It is narrative-only
  and is not Evidence.
- `update_plan`, `ask_question`, process tools (`shell`/`script`/`verify`), and file mutations (`edit`/`write`/
  `move`/`remove`) use specialized narrative cards; generic JSON Tool result remains available under a details fold.
- Action results, file diffs, and Git workspace-change diffs are diagnostics. They are not called Evidence Ledger
  records unless `evidence.recorded` exists.
- ProcessTasks are rendered from the Session's durable task projection independently of Run narrative folding;
  running servers and watchers therefore remain visible after their originating Run completes.
- Missing Goal, control receipt, evidence, or accepted memory is an explicit, explanatory empty state. When a
  Formal Plan or Work Plan is bound, the Contract pane surfaces that binding instead of leading with “No formal
  Goal”. The Web surface never fabricates those contracts from conversational behavior.

The raw history and committed SSE endpoints remain available for consumers that need protocol events directly.

## Change guide

Keep durable behavior in `packages/*`; Web-specific derivation belongs in `src/projection.ts`, and rendering belongs
in `src/assets.ts`. New event types must remain visible in Audit even before a richer Narrative renderer exists.
Add projection tests for joins and semantic labels, API tests for response compatibility, and browser acceptance for
navigation or layout changes.

Executable evidence: [`../../tests/web-workbench.test.mjs`](../../tests/web-workbench.test.mjs),
[`../../tests/web-projects.test.mjs`](../../tests/web-projects.test.mjs).
