# `@civaapple/qi-agent/loop`

The authoritative turn loop, safe steering boundary, event writer, human control batches, and crash recovery
supervisor.

## Purpose

`TurnLoop` coordinates one Run across context compilation, model streaming, proposed actions, authorization,
tool execution, settlement, feedback, and parking. It persists each boundary so a Session can be explained and
recovered without relying on process memory.

## Non-goals

- It does not weaken capability, effect, evaluation, or Kernel rules.
- It does not hide retry policy in provider adapters.
- It does not apply steering in the middle of an unsafe action boundary.

## Core model

A Run advances in Steps. Each model response may complete the response or propose Actions. `EventWriter`
commits lifecycle facts. `SteeringMailbox` queues user direction until the next safe Step boundary.
`SessionSupervisor` reconciles persisted but unsettled Actions after restart, leaves clean Plan-accept /
next-run `triggered` Runs resumable, and reports whether a pending Plan review or control Question remains.
`HumanControlService` appends atomic mode / Plan-review / next-Run Question batches; `TurnLoop` freezes mode onto
each Run, narrows the advertised tool catalog, and passes mode into Capability authorization
([ADR 0011](../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)).
Ask/Plan/Agent is the Session interaction dimension; Goal/time/event continuation policy and the
同行/追寻/守望 product entrypoints remain separate and cannot grant authority
([ADR 0013](../../design/decisions.md#adr-0013-keep-interaction-activation-and-product-language-separate)).
Session-local 追寻 uses optional `run.triggered.goalBinding` plus portable `settleGoalBoundTurn` after a
bounded Goal-bound Run settles; TurnLoop never treats model stop as Goal completion
([ADR 0033](../../design/decisions.md#adr-0033-session-local-goal-continuation-for-追寻)).
Hosts must call `settleGoalBoundTurn` (or an equivalent that uses `decideGoalContinuation` +
`applyGoalContinuationDecision`); CLI composition does this inside `TuiRuntime`. When GoalEngine already
paused the Goal for budget/stagnation, the decision is usually `await-continue` (idempotent), not a second
`pause`. Session resume demotes `active` → `paused` via `demoteActiveGoalAfterResume`. Goal ContextBlock
states that Work Plan / Formal Plan status is not completion evidence. Goal `attempts` charge only after a
Goal-bound Step that proposed a non-`read` Action (text-only / pure-read Steps are free). CLI `/goal`
surfaces Evidence Ledger gaps for observation; human Accept / Re-evaluate write ledger entries via
`HumanEvaluator`.
`RuntimeActivity` carries bounded redacted model and process previews to interactive surfaces without entering
Session truth. Model text/reasoning activities also carry approximate `estimatedOutputTokens` for live Working
strip counters. `EventWriter` refreshes an externally advanced stream before appending so independently owned
runtime lifecycles such as ProcessTasks can interleave facts without stale sequence numbers.

## Behavioral invariants

- Authority grant and `action.started` are committed before executor entry.
- Invalid input for an advertised tool becomes durable model feedback and may be corrected on the next Step.
- Each Step has a deterministic Action batch limit; excess advertised calls are rejected for reassessment.
- Unadvertised or denied actions fail closed and become durable feedback.
- Unstarted actions in a batch are settled before parking an indeterminate sibling.
- A maximal consecutive run of `read`-effect Actions in one Step authorizes and executes concurrently; write,
  execute, publish, and spend effects remain strictly sequential so write-conflict detection and edit freshness
  rebasing keep seeing every earlier write in the Step before the next one is inspected. Model-facing tool-result
  feedback always preserves the model's original request order regardless of settlement order. A cancellation or
  indeterminate settlement inside a concurrent read batch still denies only candidates strictly after that batch.
- Steering applies only after the current safe Step boundary.
- Completed user turns are reconstructed from durable Session events under a separate bounded history budget.
  Interrupted Runs restore final assistant narrative (`<qi-interrupted-run>`) or, when they carried images,
  media plus `<qi-interrupted-media-run>`. Budget-parked handoffs use `<qi-budget-handoff>`. History-budget
  omissions surface only `olderTurnsOmitted=<N>` (no Run IDs). Unfinished Agent Work Plans may inject a
  navigation ContextBlock with `wpl_*` / `wit_*` handles.
- Settled tool exchanges remain complete for their first consumer, then compact deterministically under pressure
  into a causal summary and Artifact-backed `context.compacted` checkpoint.
- Consecutive same-resource `edit` calls in one Step may use a durable, pre-authority freshness rebase after the
  prior edit settles successfully. Other repeated `file:*` / `artifact-store:*` writes fail closed as
  `BATCH_WRITE_CONFLICT`. Host execute resources are excluded from that conflict table.
- Hard budgets and repeated equivalent failures converge to a parked Run instead of spinning.
- Portable messages are redacted before provider entry, Tool feedback is already sanitized, and EventWriter
  applies a final persistence guard with value-free safety audit events.
- Provisional model/tool activity is bounded and redacted before callbacks; it cannot settle an Action or prove
  completion and is intentionally absent after restart.

## Failure semantics

Denied, failed, cancelled, parked, and indeterminate outcomes stay distinct. Unknown executor settlement parks
the Run for reconciliation; it is not automatically retried. Required context that cannot fit after compaction
parks with reason `budget`; compactor or compiler faults remain failed Runs with distinct codes.

## Install and minimal use

Most embedding callers should start with `@civaapple/qi-agent`. Direct loop composition is available when the caller
owns every lower-level port:

```sh
npm install @civaapple/qi-agent/loop @civaapple/qi-agent/kernel @civaapple/qi-ai @civaapple/qi-node/tools @civaapple/qi-agent/capability
```

```ts
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { InMemoryEventStore } from "@civaapple/qi-agent/kernel";
import { ScriptedModelPort } from "@civaapple/qi-ai";
import { TurnLoop } from "@civaapple/qi-agent/loop";
import { ToolRegistry } from "@civaapple/qi-node/tools";

const capability = new InMemoryCapabilityBroker();
const loop = new TurnLoop({
  eventStore: new InMemoryEventStore(),
  modelPort: new ScriptedModelPort(),
  toolRegistry: new ToolRegistry(capability),
});
```

## Public API

`TurnLoop`, request/result types, `RuntimeActivity`, `EventWriter`, `HumanControlService`, session-mode helpers,
`SteeringMailbox`, `SessionSupervisor`, and Goal continuation helpers
(`settleGoalBoundTurn`, `decideGoalContinuation`, `applyGoalContinuationDecision`, `demoteActiveGoalAfterResume`,
`tryCompleteGoalFromLedger`, `createGoalContextBlock`, `formatGoalContinuationNotice`).

## Change guide

Write the intended event sequence before changing orchestration. Then update protocol, projection, recovery,
tool phase, and steering tests together. Treat every executor entry as a crash boundary.

## Verification

`tests/turn-loop.test.mjs`, `tests/goal-continuation.test.mjs`, `tests/session-mode.test.mjs`, and
`tests/session-supervisor.test.mjs` are primary; `tests/tui-e2e.test.mjs` proves a
complete application path.

## Further reading

- [Turn loop](docs/turn-loop.md)
- [Safe boundaries](docs/safe-boundaries.md)
- [Convergence and stagnation](docs/convergence.md)
