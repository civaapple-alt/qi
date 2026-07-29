# Qi / 栖

Qi is a local-first, event-driven, evidence-first Agent Runtime. It keeps model proposals, human control,
authority, world effects, recovery, and completion evidence inside one observable Session.

The project is currently preparing its first public source and npm release. Package APIs should be treated as
experimental until they are published and marked stable.

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
npm install -g ./.cli-package/civaapple-qi-0.7.1.tgz
qi --help
```

## Interaction modes

- **Ask** explores with read-oriented tools.
- **Plan** may create managed Plan revisions and use read-only depth-1 research delegation.
- **Agent** uses the capabilities granted at launch.

Modes only narrow authority. Optional write, verification, network, host execution, background, and delegation
capabilities must be granted separately. `--safe` disables all optional capabilities.

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

[capabilities]
write = true
verify = true
network = false
execute = false
background = false
delegate = false

[memory]
enabled = true
auto_accept_project = true
```

`ui.timeline_density` accepts `compact`, `standard`, or `diagnostic`. It changes only the local projection:
no Session event or execution target is written. The rich TTY keeps committed conversation in a bounded
timeline, provisional Thinking/tool output in a live strip, and older Runs in the searchable `/runs` History
Center.

Memory is captured only from explicit `/memory` actions or provenance-backed proposals during new Runs; Qi does
not mine old conversations. Session and Project Memory stay in the current project. Only explicitly confirmed
User Memory is stored in `$QI_HOME/state` and retrieved across projects.

For Kimi Code, `model = "k3"` automatically selects a 1,048,576-token window; `k3-256k`,
`kimi-for-coding`, and `kimi-for-coding-highspeed` select 262,144 unless `context_window_tokens` overrides it.
Optional `reasoning_effort` accepts K3's `low`, `high`, `max`, or `none` modes (plus documented aliases);
the default is `high`.
The Kimi `/login` form exposes the four known models as a dropdown with a final custom-ID input, shows the
effective effort/context defaults, and persists edits without placing the API key in TOML.

Project policy lives under `$QI_HOME/projects/<workspace-name>-<path-hash>/policy.toml`. Resolution order is:

```text
CLI flags > project config > user config > built-in defaults
```

Read-only external directories can be added with `--add-dir PATH` or `/mounts`. Mounted paths use
`mount:<id>/...`; writes remain confined to the primary Workspace.

Provider credentials may come from environment variables or `/login`. Credentials are sealed behind
execution-side handles and are not persisted in Session events, Artifacts, or TOML.

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

Qi 0.6 uses `$QI_HOME/layout.json` generation 2. Runtime databases and machine policy live under
`$QI_HOME/projects/<workspace-name>-<path-hash>/`; Workspace `.qi` contains only versionable declarations and
package locks. Existing non-empty 0.5 data roots are not migrated or deleted automatically.

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
