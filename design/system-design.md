# Qi system design

Qi（栖）是一个 local-first、event-driven、evidence-first 的 Agent Runtime。它让人和 Agent 在同一个
可观察、可恢复的本地世界里工作，同时把“模型建议做什么”和“系统允许发生什么”明确分开。

本文只描述当前系统。产品为何强调生命感、共处、同行/追寻/守望和有限自治，见
[product-vision.md](product-vision.md)；设计决策与约束见 [decisions.md](decisions.md)，包级行为见
`packages/*/README.md`。

## 1. Goals and non-goals

Qi 的目标是：

- 让 Session 的事实可重放，而不是只保留聊天文本；
- 让能力授权、外部效果和完成证据可检查；
- 让用户能够暂停、转向、拒绝和恢复工作；
- 让身份、Goal、Memory、真实状态和行动后果形成跨回合的连续关系；
- 让模型、存储、工具、UI 和扩展机制可替换但不能绕过控制边界；
- 让本地 CLI 与可嵌入 TypeScript 包共享同一套 Runtime 语义。

当前不追求：

- 把概率模型输出当作权限或事实；
- 默认开放写入、执行、网络、后台任务或委派；
- 用多个可写进程并发驱动同一活动 Session；
- 自动重试结算未知的外部效果；
- 默认启用递归 Multi-Agent；
- 把只读 Web 界面包装成尚不存在的远程控制平面。

## 2. Architecture overview

```text
Human / embedding caller
        |
        v
apps/cli or @civaapple/qi-agent
        |
        v
Turn Loop ---- Context Compiler ---- ModelPort
   |                                   |
   | proposals                         | provider adapter
   v                                   v
Tool Registry -> Capability Broker -> Executor -> Effect Journal
   |                  |                   |             |
   +------------------+-------------------+-------------+
                              |
                              v
                    append-only Session events
                              |
                  +-----------+-----------+
                  v                       v
               Kernel                 EventStore
             projection               SQLite/memory
                  |
          +-------+--------+
          v                v
        TUI          read-only Web/SSE
```

The Runtime is composed locally by the `qi` process. Public packages expose the same lower-level boundaries for
embedding; they do not create alternate lifecycle or authority paths.

## 3. Session lifecycle and durable truth

A Session owns an append-only event stream. Runs contain Steps; Steps contain Actions. The Kernel validates each
transition and rebuilds a `SessionView` projection from events.

Important rules:

- event order and identity links are validated;
- a Run cannot become terminal while an Action has unknown settlement;
- `failed`, `cancelled`, `parked`, `denied`, and `indeterminate` remain distinct;
- steering applies at a safe Step boundary;
- committed events are durable truth; UI animation and streaming previews are provisional;
- compatible schema changes are additive; incompatible storage changes require explicit migration evidence.

SQLite stores event streams atomically. The in-memory store is useful for embedding and deterministic tests.
Neither store invents domain transitions.

The golden trace at `fixtures/golden/authority-denied.json` proves that a denied publish Action replays to the
same parked Run across Kernel, stream, and SQLite tests.

## 4. Workspace, authority, and effects

Tool processing is split into separate phases:

1. discover a typed Tool;
2. validate arguments and target resources;
3. request authority for the current intent;
4. persist grant and `ActionStarted`;
5. enter the executor;
6. settle the effect and Action;
7. attach evidence or Artifacts.

Capability checks deny by default. Leases are scoped, expiring, and use-bounded. Delegation can only narrow a
parent lease. Session mode and product policy may narrow authority further but never widen it.

The primary Workspace is the only writable root. Human-approved extra directories are read-only mounts using
`mount:<id>/...`. `.qi`, `.git`, and `.artifacts` are protected paths and never enter ordinary Agent file
authority.

Non-read effects use the Effect Journal with stable idempotency keys. A completed effect may replay its recorded
result. An indeterminate effect is not automatically retried because doing so could duplicate an external
action.

File edits require fresh observations and precise targets. Host process execution is advertised honestly as
host execution, not a sandbox. Long-lived servers use bounded ProcessTasks with ownership, expiry, logs, stop,
and recovery semantics.

## 5. Context, models, and memory

`@civaapple/qi-ai` defines a portable streaming model protocol. Provider profiles explicitly declare wire API,
auth schemes, model window, and supported capabilities. Provider-specific details do not enter Session truth.

Credential values remain behind execution-side handles. High-confidence secret redaction runs before provider
requests and durable persistence.

The Context Compiler selects source-aware blocks under a working budget. Model window, output reserve, and prompt
budget are distinct. Settled exchanges may compact into causal summaries plus Artifact references; complete
events remain unchanged.

Runtime truth is not copied wholesale into model context. Runtime-owned blocks are a least-information disclosure
boundary: each has an explicit purpose and allowlisted semantic schema, omits internal IDs and unrelated telemetry,
and cannot grant authority or prove completion. Detailed lifecycle facts remain behind bounded introspection
Actions. See ADR-0026.

Memory is not transcript accumulation. Claims have provenance, structured Session/Project/User scope, confidence,
correction, forgetting, activation, and sensitivity rules. Project claims stay within one project; explicitly
confirmed User claims live in a machine-private Continuity Session and may cross projects. Project and user
SQLite indexes are rebuildable projections. Only accepted, relevant or explicitly always-active claims can enter
context, and Context Compiler records whether each optional block was included. Sensitive, relational, and
User-scoped claims do not self-promote.

## 6. Goals, evidence, and completion

A Goal contains assertions and resource limits. Evaluators produce explicit outcomes and Evidence Ledger
entries. Kernel completion policy distinguishes:

- a model response;
- a completed bounded Run;
- an evidence-backed verified result.

Semantic judgment is trusted only after calibration. Otherwise it projects to `unknown`, even if the evaluator
reported a confident answer. Repeated equivalent failures, resource exhaustion, or unresolved effects park work
instead of manufacturing success.

Artifacts hold bounded outputs, complete diffs, summaries, and other data that should not remain inline in model
context. References preserve the path from compact views to detailed evidence.

## 7. Human control and application surfaces

Session interaction mode is durable:

- **Ask**: read-oriented exploration and answers;
- **Plan**: read-oriented exploration, managed Plan revisions, and read-only depth-1 research delegation;
- **Agent**: the full granted launch upper bound.

Plan acceptance starts exactly one Plan-bound Run. Later items require an explicit durable choice. Questions and
approvals survive restart and cannot grant authority merely because a UI control was clicked.

面向人的产品入口是**同行、追寻、守望**；它们分别主要投影 Turn、Goal 和 Time/Event 关系。
它们不是 Session mode，也不直接授予 Action authority。四种激活与延续方式
`Turn-based / Goal-based / Time-based / Proactive` 的产品含义与边界见
[产品愿景 §6](product-vision.md#6-自治不是一个开关)。

`apps/cli` owns provider login, policy resolution, stores, Tool construction, process ownership, and interactive
control. `@civaapple/qi-tui` owns reusable projections and terminal components only.

`apps/web` reads committed SQLite history and SSE. It cannot execute, approve, grant, or write Session state.
它是未来关系与世界控制面的只读基础；在写入、认证、授权和单写者协议成立前，不声称已经提供远程
控制能力。

## 8. Extensions: Skills, MCP, CodeAct, graph, delegation, scheduling, and introspection

Extensions attach through existing boundaries:

- **Skills** expose validated metadata and progressively loaded instructions; they never grant authority.
- **MCP** discovery is quarantined until a remote schema is compiled, reviewed, and explicitly bound.
- **CodeAct** expresses short programs, but every nested Tool call retains normal authorization and Action events.
- **Graph Governor** narrows observations, tools, and model routes; deterministic guards still win.
- **Coordinator** runs depth-1 isolated Subagents under strict child leases and durable settlement.
- **Scheduler** owns bounded timer/event watchers with lifetime, attention, and idempotent delivery rules.
- **Introspection** exposes versioned, read-only knowledge about packages, invariants, decisions, and gaps.

None of these mechanisms is a privileged execution path. Multi-Agent stays opt-in and must not expand the parent
Session's authority.

## 9. Package boundaries

| Package | Responsibility |
| --- | --- |
| `@civaapple/qi-protocol` | Wire IDs, Session event schemas, parsing, and compatibility |
| `@civaapple/qi-ai` | ModelPort, provider adapters, and deterministic Context Compiler |
| `@civaapple/qi-agent` | Kernel, TurnLoop/EventWriter, capability, portable Tool/Effect ports, evaluation, memory policy, coordination, and extension contracts |
| `@civaapple/qi-node` | Paths, SQLite, Workspace, built-in Tools, package installation, Skills, MCP, CodeAct, Scheduler, stream/SSE, and encrypted storage |
| `@civaapple/qi-tui` | Reusable terminal projections and controls |
| `@civaapple/qi` | CLI, package management, trust prompts, and product composition |

Applications live under `apps/`: `cli` is the execution composition; `web` is a read-only understanding surface.

The dependency direction is `protocol + ai -> agent -> node`, while `tui` depends only on `protocol + agent`.
The CLI composes all five runtime packages. Subpaths expose cohesive modules without creating more publication
units. State/event ownership remains: Protocol defines events; Agent Kernel validates and projects; Agent Loop
produces; Node storage persists; Node stream transports committed events.

### Private and shared data

`@civaapple/qi-node/paths` is the only path resolver. `$QI_HOME/layout.json` identifies layout generation 2
(Qi 0.6). Machine-private credentials, user resources, the content-addressed package store, and project-private
state live under `$QI_HOME`. Each project directory is `<basename>-<canonical-realpath-sha256-prefix>` and keeps
SQLite databases in `state/`, plus Artifacts, Plans, Tasks, activation, cache, and temporary data.

Workspace `.qi` is an allowlisted declaration surface only: package request/lock files, frozen verify profiles,
Skills, prompts, themes, Agent/workflow declarations, and secret-free MCP declarations. It contains no runtime
database, package payload, executable code, credential, Artifact, log, cache, or temporary file. Ordinary Agent
file tools remain denied; dedicated services validate and atomically write only their owned subtree.

Declarative packages may originate from exact npm versions with registry integrity, Git commits, or digest-pinned
local directories. Installation stages without lifecycle scripts, validates paths/types/size/symlinks/secrets,
then atomically publishes immutable content under `$QI_HOME/packages/store/sha256-*`. Registration contributes
resources but never a Capability Lease. Executable third-party plugins require a future isolation ADR.

## 10. Verification and maturity

Tests are part of the public design evidence, especially for:

- authority before executor entry;
- default-deny and delegation narrowing;
- replay and crash recovery;
- distinct failure/settlement outcomes;
- secret redaction;
- Effect Journal idempotency;
- old-history compatibility;
- package export and isolated consumer behavior;
- bounded TUI projection;
- read-only Web behavior.

The standard local gate is:

```sh
npm run typecheck
npm test
npm run packages:check
npm run accept:preview
npm run release:audit
```

See [roadmap.md](roadmap.md) for maturity vocabulary and remaining release/product validation work.
