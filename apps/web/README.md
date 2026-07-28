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
- Run labels use recorded user input; selecting one updates the URL and moves the center view to that Run.
- A Step whose model requested Actions is not presented as fully complete until those Actions settle.
- Action lifecycle labels are derived by joining events on `actionId`; later events never invent missing authority
  or tool identity.
- ProcessTasks are rendered from the Session's durable task projection independently of Run narrative folding;
  running servers and watchers therefore remain visible after their originating Run completes.
- Action results and Workspace diffs are diagnostics. They are not called Evidence Ledger records unless
  `evidence.recorded` exists.
- Missing Goal, control receipt, evidence, or accepted memory is an explicit, explanatory empty state. The Web
  surface never fabricates those contracts from conversational behavior.

The raw history and committed SSE endpoints remain available for consumers that need protocol events directly.

## Change guide

Keep durable behavior in `packages/*`; Web-specific derivation belongs in `src/projection.ts`, and rendering belongs
in `src/assets.ts`. New event types must remain visible in Audit even before a richer Narrative renderer exists.
Add projection tests for joins and semantic labels, API tests for response compatibility, and browser acceptance for
navigation or layout changes.

Executable evidence: [`../../tests/web-workbench.test.mjs`](../../tests/web-workbench.test.mjs),
[`../../tests/web-projects.test.mjs`](../../tests/web-projects.test.mjs).
