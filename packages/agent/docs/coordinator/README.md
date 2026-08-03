# `@civaapple/qi-agent/extensions`

Explicit, evidence-gated delegation to isolated child Sessions under narrowed capability leases.

## Purpose

The Coordinator creates a child Session and optional workspace branch for a bounded contract, delegates only a
subset of parent authority, and structurally checks returned deliverables and evidence references.
`runDelegatedTurn` executes a depth-1 child TurnLoop under that contract and returns only Artifact refs plus a
short summary to the parent — never the child transcript.

## Non-goals

- Multi-Agent is not the default execution mode.
- Delegation does not share mutable Session state or widen authority.
- A child summary is not accepted as evidence by itself.
- Recursive Subagents (`depth > 1`) are rejected.

## Core model

A `DelegationContract` defines task, evidence requirements, child scope, and a hard resource envelope
(`contextTokens`, `maxSteps`, `wallTimeMs`). Authorization requires a durable Control Receipt with
`delegationRight`. `DelegationHandle` identifies the isolated Session and branch. Submission is checked against
the contract before it can re-enter the parent flow. `MultiAgentBaselineGate` separately requires paired
evaluation evidence before enabling multi-Agent by default.

## Behavioral invariants

- Child leases are an intersection with parent authority.
- Child work has separate Session identity and isolated context compilation from allowlisted `contextRefs`.
- Return is attributable and gated by deliverable schema, required references, and evidence-kind counts; semantic
  or behavioral validity remains the Eval/integration layer's responsibility.
- Running delegations are settlement boundaries: recovery cancels them before parking the parent Run.
- Multi-Agent remains off unless paired target evaluations show measured advantage.

## Failure semantics

Scope widening, missing evidence, invalid child identity, workspace failure, wall-time timeout, and baseline
rejection remain explicit. A failed child does not corrupt or silently complete the parent. Orphaned child work
is not automatically retried.

## Install and minimal use

```sh
npm install @civaapple/qi-agent/extensions
```

```ts
import { MultiAgentBaselineGate } from "@civaapple/qi-agent/extensions";

const gate = new MultiAgentBaselineGate(3);
console.log(gate.decision("eval_coding").enabledByDefault); // false until paired evidence exists.
```

## Public API

`Coordinator`, `runDelegatedTurn`, `runDelegatedBatch`, `contextBlocksFromRefs`, delegation
contract/handle/submission types, workspace branch port, and `MultiAgentBaselineGate`.

## Change guide

Any new sharing mechanism must preserve identity, authority monotonicity, evidence provenance, and parent control.
Add a single-Agent comparison before widening use of coordination.

## Verification

`tests/coordinator.test.mjs` covers isolated delegation, lease narrowing, receipt authorization, recovery cancel,
evidence return, and baseline gating.

## Further reading

- [Delegation contract](docs/delegation.md)
- [Baseline gate](docs/baseline-gate.md)
- [ADR 0008](../../design/decisions.md#adr-0008-limit-subagent-delegation-to-one-isolated-layer)
- [Coordinator design](../../design/system-design.md#8-extensions-skills-mcp-codeact-graph-delegation-scheduling-and-introspection)
