# Delegation contract

Delegation creates an isolated child responsibility, not a shared swarm mind. The parent remains accountable for
the contract and decides whether the evidence-backed return can be integrated.

## Creation

A `DelegationContract` specifies task, required evidence, child capability scope, allowlisted `contextRefs`, and a
resource envelope. Authorization is a Control Receipt with `delegationRight`. The Coordinator persists the
contract body as an Artifact (`contractRef`), creates a distinct child Session, optionally asks a configured
branch port for a Workspace branch, and asks the Capability Broker for a narrowed delegated lease.

## Child execution

`runDelegatedTurn` launches an ordinary TurnLoop in the child Session with:

- an independent Context Compiler fed only by allowlisted Artifact refs
- `toolAllowlist` equal to the child lease tools (never `delegate`)
- hard limits from `resourceEnvelope` (`contextTokens`, `maxSteps`, `wallTimeMs`)

`runDelegatedBatch` accepts 1–4 `{ contract, input }` items, records every `delegation.created` first, then runs
child Turns concurrently under a shared abort signal. Each child still settles through `Coordinator.return`.
Plan research may use this fan-out; depth remains exactly one (ADR-0008 / ADR-0035).

Applications that construct `Coordinator` for a live UI should pass `onEvent` so parent `delegation.created` /
`delegation.returned` reach the same consumer as TurnLoop facts; otherwise Tasks panels can stay empty while the
child Action is still running.

Child wall-time expiry settles as `timed_out` (not `cancelled`). TurnLoop aborts look like cancel internally;
`runDelegatedTurn` / `runDelegatedBatch` remap wall-time aborts so the parent can integrate partial summaries
instead of treating the fan-out as a user interrupt.

Applications may also drive the child loop themselves, but they must settle through `Coordinator.return`.

## Return

A `DelegationSubmission` contains the child result and references to required evidence. Outcomes are
`accepted | rejected | cancelled | timed_out | failed`. The Coordinator checks the active handle and child
identity, deliverable schema, required result/trace references, and evidence-kind counts before recording an
accepted or rejected return. It does not dereference those references or independently prove that the child
Session completed; trusted completion remains an Eval/integration responsibility.

CLI `runDelegatedTurn` stores a short preview in `summaryRef` and the full child deliverable text in `resultRef`
(hard-capped). Parents should load Artifact store content with a dedicated read tool (`artifact_get`), not
workspace `read` on `artifact://` paths. See ADR-0035 for Plan fan-out, Jobs vs Tasks, and user `[delegate]`
envelope overrides.

```text
parent contract + receipt -> isolated child work -> evidence-gated submission -> parent decision
```

## Recovery

If the process restarts while a delegation is `running`, Session recovery cancels the delegation before parking
the parent Run. Child work is not auto-resumed.

## Failure

A child may fail, cancel, park, time out, or return insufficient evidence. These are child outcomes, not
automatic parent failure or completion. The parent can revise the contract, continue alone, or explicitly
abandon the branch.

See `tests/coordinator.test.mjs` and [ADR 0008](../../../design/decisions.md#adr-0008-limit-subagent-delegation-to-one-isolated-layer).
