# Context Compiler contract

Context compilation is a deterministic allocation problem, not arbitrary message concatenation.

## Inputs

Every `ContextBlock` has stable identity, kind, priority, required status, and content. A caller supplies an
explicit token budget and estimator.

## Algorithm

1. Reject duplicate block IDs.
2. Estimate every block with the same estimator.
3. Include all required blocks or throw `ContextBudgetError`.
4. Order optional blocks deterministically by policy.
5. Include optional blocks while budget remains.
6. Return included blocks, omitted blocks, and total estimated cost.

## Integration rules

- Loop error compaction should supply a short causal block and keep raw logs behind an Artifact reference.
- Memory retrieval supplies candidate blocks but does not mark them required without policy.
- Skill and MCP details remain progressively disclosed.
- Provider-specific token counting can implement `TokenEstimator` without changing selection semantics.
- Runtime-owned blocks are allowlisted disclosure views, not serialized projections. Their caller must define the
  model decision being supported, use the least precise bounded value sufficient for it, and omit internal
  Session/Run/Step/Action IDs and unrelated telemetry unless the owning ADR explicitly requires one.
- Runtime metadata in context never grants authority or becomes completion evidence. Detailed Runtime state stays
  behind explicit bounded introspection Actions.

Any heuristic change must preserve deterministic tie-breaking and explicit omission reporting. See the context
cases in `tests/llm-context.test.mjs`.
