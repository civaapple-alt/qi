# Context Compiler contract

Context compilation is a deterministic allocation problem, not arbitrary message concatenation.

## Inputs

Every `ContextBlock` has stable identity, kind, priority, required status, and content. A caller supplies an
explicit token budget and estimator.

The default estimator is deterministic and conservative: ASCII is estimated near four characters per token,
while every non-ASCII code point reserves two tokens. Serialized message and Tool callers also add framing.
`ModelCapabilities.tokenEstimator` may provide a provider/model-calibrated implementation without changing
selection semantics.

## Algorithm

1. Reject duplicate block IDs.
2. Estimate every block with the same estimator.
3. Include all required blocks and any `pinnedOptionalIds` that are present, or throw `ContextBudgetError`.
4. Order remaining optional blocks deterministically by policy.
5. Include optional blocks while budget remains.
6. Return included blocks, omitted blocks, total estimated cost, and per-kind included/omitted count/token
   aggregates.

`pinnedOptionalIds` supports Run-scoped freeze so optional Memory/Skills membership does not flicker solely
because remaining budget shrinks on a later Step (ADR-0034).

## Integration rules

- Loop error compaction should supply a short causal block and keep raw logs behind an Artifact reference.
- Memory retrieval supplies candidate blocks but does not mark them required without policy.
- Skill and MCP details remain progressively disclosed.
- Provider-specific token counting can implement `TokenEstimator` without changing selection semantics.
- A Turn integration must use the same estimator for ContextBlocks, portable messages, and advertised Tool
  schemas. It reserves current input, required control/policy, Tool schemas, and any control trailer before
  selecting whole restored turns and optional prefix blocks. Work Plan / Goal / budget control belong in the
  TurnLoop trailer (outside this compiler's optional pick), not as mid-prefix system text that rewrites each Step
  (ADR-0034).
- Runtime-owned blocks are allowlisted disclosure views, not serialized projections. Their caller must define the
  model decision being supported, use the least precise bounded value sufficient for it, and omit internal
  Session/Run/Step/Action IDs and unrelated telemetry unless the owning ADR explicitly requires one.
- Runtime metadata in context never grants authority or becomes completion evidence. Detailed Runtime state stays
  behind explicit bounded introspection Actions.

Any heuristic change must preserve deterministic tie-breaking and explicit omission reporting. See the context
cases in `tests/llm-context.test.mjs`.
