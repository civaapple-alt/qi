# Qi / 栖

Qi is a local-first, event-driven, evidence-first Agent Runtime. It keeps model proposals, human control,
authority, world effects, recovery, and completion evidence inside one observable Session.

The project is currently preparing its first public source and npm release. Package APIs should be treated as
experimental until they are published and marked stable. Dated 0.7.x changelog sections are source milestones;
they do not by themselves mean that packages were published or that a stable compatibility baseline exists.

## Why Qi

Qi（栖）希望建立一个让人和 Agent 共处的世界：Agent 不只是一次性回答器，而是在真实边界内拥有
连续性、记忆、Goal、行动后果和节律的伙伴。生命感来自共同经历和可观察状态，不来自虚构意识或
角色表演；自治也不是一个 `auto` 开关，而是可见、可撤回、有停止条件的控制权。

产品以**同行、追寻、守望**表达三种关系体验，并让 CLI 与 Web 呈现同一份可观察、可恢复的世界。
完整主张见 [产品愿景](design/product-vision.md)。

在 Runtime 层，Qi 将模型建议、工具执行和成功声明从不透明的单一路径中拆开：

- Session events are append-only durable truth.
- Capability checks deny by default and cannot be widened by delegation.
- Tool discovery, validation, authorization, execution, and settlement are distinct phases.
- Non-read effects use an Effect Journal; indeterminate effects are never retried automatically.
- `failed`, `cancelled`, `parked`, `denied`, and `indeterminate` remain different outcomes.
- Verified completion requires matching evidence.
- Skills, MCP metadata, graphs, memory, and introspection never grant authority.

Read [the system design](design/system-design.md) for the architecture and
[current decisions](design/decisions.md) for the cross-package constraints.

## Install

Requirements:

- Node.js 22.19.0 or newer
- npm

From a source checkout:

```sh
npm ci
npm run build
npm run qi
```

The target npm package is `@civaapple/qi`, and the installed executable is `qi`. Until publication is explicitly
authorized, create and test a local tarball:

```sh
npm run pack:cli
npm install -g ./.cli-package/civaapple-qi-0.7.4.tgz
qi --help
```

## Interaction modes

**Session mode** (`ask` | `plan` | `agent`) only **narrows** what a Run may do:

- **Ask** explores with read-oriented tools.
- **Plan** may create managed Plan revisions and use read-only depth-1 research delegation.
- **Agent** may use the coding lease pack (or expert `[capabilities]`) under the current permission mode.

**Permission mode** (`manual` | `yolo` | `auto`, [ADR-0040](design/decisions.md#adr-0040-permission-mode-manual--yolo--auto-orthogonal-to-session-mode))
is orthogonal: it controls **approval rhythm**, not Session mode.

| Permission | Behavior |
| --- | --- |
| **manual** (default) | Non-read in-lease tools ask with Once / Session / Project memory |
| **yolo** | Auto-accept in-lease tools; path guards + OS sandbox fail closed |
| **auto** | Like yolo, and suppress tool-form `ask_question` |

Daily TUI control is `/permission`; expert multi-select remains `/permissions`. CLI: `--permission manual|yolo|auto`.
`--safe` forces a read-only research baseline.

**Process sandbox** ([ADR-0041](design/decisions.md#adr-0041-graded-process-sandbox-srt--windows-low-il--host)):
`shell` / `script` / `verify` / skill scripts / MCP stdio use graded isolation (`srt` → Windows Low IL → host).
Inspect with `qi sandbox status`. In-process file tools stay on path/capability guards only.

### Headless (print) mode

Scripts and CI can run a single prompt without the TUI:

```bash
qi -p "Explain this repository"
qi -p --output-format json --mode ask "List public packages"
qi -p --permission yolo --allow-write "Apply a one-line fix"
```

See [`apps/cli/docs/headless.md`](apps/cli/docs/headless.md). Non-read effects still need leases (permission pack,
`--allow-*`, or project policy); print mode does **not** auto-approve mounts or invent Cursor-style `--force`.
Default permission remains **manual** without TTY (in-lease writes deny unless Project memory / yolo).

Inspect effective configuration without starting a chat:

```bash
qi config show
qi config validate
qi config doctor
qi sandbox status
```

See [`apps/cli/docs/configuration.md`](apps/cli/docs/configuration.md).

### IDE integration (ACP)

```bash
qi acp
```

Compatible editors (Zed, JetBrains, …) can launch `qi acp` as an Agent Client Protocol subprocess.
See [`apps/cli/docs/acp.md`](apps/cli/docs/acp.md).

## Current product surface

The primary productized relationship today is user-triggered **同行** through Ask, Plan, and Agent Runs. Formal
Plans hand one immutable design to an implementation Run; Work Plans provide in-Run navigation without becoming
completion evidence. Memory, bounded Run history, Session archive/recovery, image input, ProcessTasks, and
configurable shell profiles keep that work observable and recoverable.

Session-local **追寻** is available through `/goal` with Goal-bound Runs and evidence-backed completion, but it
is not yet product-validated with external users. **守望** still rests on Scheduler foundations without a stable
end-to-end product entry. Both remain product directions until continuation, attention, notification, stop, and
recovery experiences have been validated with users.

## Configuration

Qi reads `%USERPROFILE%\.qi\config.toml` on Windows and `~/.qi/config.toml` elsewhere.
`QI_CONFIG` or `--config PATH` selects another file. API keys are not accepted in TOML.

```toml
version = 1
language = "zh"
provider = "openai"
model = "gpt-5.4-mini"
context_window_tokens = 128000

[ui]
timeline_density = "standard"

[permission]
default = "manual"    # manual | yolo | auto

[sandbox]
policy = "auto"       # auto | srt | low-il | never

# Optional expert override. When omitted, permission mode expands the coding lease pack.
# [capabilities]
# write = true
# execute = true

[delegate]
wall_time_ms = 300000
max_steps_percent = 50
context_tokens_percent = 50

[memory]
enabled = true
auto_accept_project = true
```

Project policy may set `[permission].mode`, `[sandbox].policy`, `[[mounts]]`, and `[[approvals]]`
(see [configuration.md](apps/cli/docs/configuration.md)).

`[delegate]` is optional; omitted keys use the defaults above (5-minute wall, 50% of parent maxSteps/context).
Edit under `/settings` → Subagent or `/subagent`. Batch max 4 and depth 1 stay fixed.

`ui.timeline_density` accepts `compact`, `standard`, or `diagnostic`. It changes only the local projection:
no Session event or execution target is written. The rich TTY keeps committed conversation in a bounded
timeline, provisional Thinking/tool output in a live strip, and older Runs in the searchable `/runs` History
Center.

Memory is captured only from explicit `/memory` actions or provenance-backed proposals during new Runs; Qi does
not mine old conversations. Session and Project Memory stay in the current project. Only explicitly confirmed
User Memory is stored in `$QI_HOME/state` and retrieved across projects.

For Kimi Code, `model = "k3"` automatically selects a 1,048,576-token window; `k3-256k`,
`kimi-for-coding`, and `kimi-for-coding-highspeed` select 262,144 unless `context_window_tokens` overrides it.
K3 supports `reasoning_effort = "low" | "high" | "max"` and defaults to `high`. K2.7 Code models keep thinking
always on. Other model profiles expose only the effort values they explicitly declare.
The Kimi `/login` form exposes the four known models as a dropdown with a final custom-ID input, shows the
effective effort/context defaults, and persists edits without placing the API key in TOML.

**Volcengine Agent Plan** uses `provider = "volcengine-agent-plan"`, `ARK_API_KEY`, and Responses at
`https://ark.cn-beijing.volces.com/api/plan/v3` (default model `glm-latest`). Thinking models accept
`reasoning_effort = "low" | "medium" | "high"`; `/model` Max output tokens maps to Responses
`max_output_tokens`.

**Qianwen AI Token Plan** uses `provider = "qianwenai"`, `QIANWENAI_API_KEY`, and
`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` (default model `qwen3.8-max`).
Qwen models use Responses; `glm-5-2` / `deepseek-v4-pro` use Chat Completions. Thinking accepts
`reasoning_effort = "low" | "medium" | "high" | "max"`. See
[`packages/ai/docs/model/provider-adapters.md`](packages/ai/docs/model/provider-adapters.md).

Project policy lives under `$QI_HOME/projects/<workspace-name>-<path-hash>/policy.toml`. Resolution order is:

```text
CLI flags > project config > user config > built-in defaults
```

Read-only external directories can be added with `--add-dir PATH` or `/mounts`. Mounted paths use
`mount:<id>/...`; writes remain confined to the primary Workspace.

Provider credentials may come from environment variables or `/login`. Credentials are sealed behind
execution-side handles and are not persisted in Session events, Artifacts, or TOML.
Sensitive Workspace paths require a human content grant before their bodies reach the model. Once authorized,
ordinary Tool reads preserve exact file content—including source examples containing authorization-header
syntax—rather than rewriting strings that precise edits need to round-trip.

## Packages

| Package | Responsibility |
| --- | --- |
| [`@civaapple/qi-protocol`](packages/protocol) | Durable IDs and Session event schemas |
| [`@civaapple/qi-ai`](packages/ai) | ModelPort, provider adapters, and Context Compiler |
| [`@civaapple/qi-agent`](packages/agent) | State machine, lifecycle, capability, portable Tool/Effect ports, evaluation, memory, and extension contracts |
| [`@civaapple/qi-node`](packages/node) | Paths, SQLite, Workspace, built-in Tools, package installer, Skills, MCP, CodeAct, Scheduler, and SSE |
| [`@civaapple/qi-tui`](packages/tui) | Reusable terminal projections and controls |
| [`@civaapple/qi`](apps/cli) | CLI, package management, and product composition |

`apps/cli` is the interactive execution composition. `apps/web` is a read-only local history workbench.

The 0.7.0 source milestone introduced `$QI_HOME/layout.json` generation 2. Project-level indexes and machine
policy live under `$QI_HOME/projects/<workspace-name>-<path-hash>/`, while each Session owns a self-contained
active or archived directory for its event database, Effect Journal, Artifacts, Plans, and Tasks. Home layout
generation, project layout version, and database schema versions are separate boundaries. Workspace `.qi`
contains only versionable declarations and package locks.

During pre-stable development, unsupported Session or private-layout generations may be rejected without
automatic migration. Qi leaves such data unchanged and asks the operator to back it up, reset it, or select a new
`QI_HOME` / data root before continuing.

Declaration-only packages install with `qi install npm:<name>@<exact-version>`, `qi install
git:<url>#<commit>`, or `qi install local:<path>`. Use `--scope project` to write the exact lock to Workspace
`.qi`; verified package content stays in the shared `$QI_HOME/packages/store`.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Important commands:

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile the TypeScript project graph |
| `npm run typecheck` | Type-check the project graph without emitting files |
| `npm test` | Build and run the deterministic and integration test suite |
| `npm run verify:focused` | Build once, then run named tests during iteration; pass `-- tests/<name>.test.mjs …` |
| `npm run clean` | Remove TypeScript project-reference build output |
| `npm run qi` | Start the CLI from source after build |
| `npm run qi:web` | Start the read-only Web workbench |
| `npm run build:cli` | Stage the self-contained CLI package without creating a tarball |
| `npm run pack:cli` | Build a self-contained CLI tarball |
| `npm run accept:preview` | Pack, install, and safely start the CLI in disposable directories |
| `npm run accept:compare-prompts` | Compare repeated prompt-evaluation JSONL files (`-- baseline.jsonl candidate.jsonl`) and enforce safety/success gates |
| `npm run packages:audit` | Audit public package manifests and tarballs |
| `npm run packages:check` | Run isolated JavaScript/TypeScript consumers for every Runtime package |
| `npm run packages:plan` | Validate the coordinated dependency graph and release order |
| `npm run release:audit` | Scan the source candidate and report release blockers |
| `npm run release:archive` | Build a versioned source archive after all gates pass |
| `npm run accept:coding-agent` | Opt-in live-provider acceptance; consumes API quota |

The repository intentionally keeps tests, the golden replay fixture, and release/build scripts. They are
executable evidence for safety boundaries and package installability, not generated release output.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution workflow, [SECURITY.md](SECURITY.md) for vulnerability
reporting, [CHANGELOG.md](CHANGELOG.md) for release notes, and [design/roadmap.md](design/roadmap.md) for maturity
and remaining work.

## License

[MIT](LICENSE)
