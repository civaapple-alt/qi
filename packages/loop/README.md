# `@civaapple/qi-loop`

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
`RuntimeActivity` carries bounded redacted model and process previews to interactive surfaces without entering
Session truth. `EventWriter` refreshes an externally advanced stream before appending so independently owned
runtime lifecycles such as ProcessTasks can interleave facts without stale sequence numbers.

## Behavioral invariants

- Authority grant and `action.started` are committed before executor entry.
- Invalid input for an advertised tool becomes durable model feedback and may be corrected on the next Step.
- Each Step has a deterministic Action batch limit; excess advertised calls are rejected for reassessment.
- Unadvertised or denied actions fail closed and become durable feedback.
- Unstarted actions in a batch are settled before parking an indeterminate sibling.
- Steering applies only after the current safe Step boundary.
- Completed user turns are reconstructed from durable Session events under a separate bounded history budget.
- Settled tool exchanges remain complete for their first consumer, then compact deterministically under pressure
  into a causal summary and Artifact-backed `context.compacted` checkpoint.
- A second non-read write to the same resource in one Step fails closed as `BATCH_WRITE_CONFLICT` so the model can
  re-read instead of hitting a follow-on `STALE_READ`.
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
npm install @civaapple/qi-loop @civaapple/qi-kernel @civaapple/qi-llm @civaapple/qi-tools @civaapple/qi-capability
```

```ts
import { InMemoryCapabilityBroker } from "@civaapple/qi-capability";
import { InMemoryEventStore } from "@civaapple/qi-kernel";
import { ScriptedModelPort } from "@civaapple/qi-llm";
import { TurnLoop } from "@civaapple/qi-loop";
import { ToolRegistry } from "@civaapple/qi-tools";

const capability = new InMemoryCapabilityBroker();
const loop = new TurnLoop({
  eventStore: new InMemoryEventStore(),
  modelPort: new ScriptedModelPort(),
  toolRegistry: new ToolRegistry(capability),
});
```

## Public API

`TurnLoop`, request/result types, `RuntimeActivity`, `EventWriter`, `HumanControlService`, session-mode helpers,
`SteeringMailbox`, and `SessionSupervisor`.

## Change guide

Write the intended event sequence before changing orchestration. Then update protocol, projection, recovery,
tool phase, and steering tests together. Treat every executor entry as a crash boundary.

## Verification

`tests/turn-loop.test.mjs`, `tests/session-mode.test.mjs`, and `tests/session-supervisor.test.mjs` are primary;
`tests/tui-e2e.test.mjs` proves a
complete application path.

## Further reading

- [Turn loop](docs/turn-loop.md)
- [Safe boundaries](docs/safe-boundaries.md)
- [Convergence and stagnation](docs/convergence.md)
