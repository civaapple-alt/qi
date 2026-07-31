# CLI model-context contract

Qi builds a fresh, deterministic model-context recipe for every Run. The recipe helps the model choose an
action; it does not grant authority, settle an effect, or prove completion. Capability policy, the Tool Registry,
the Effect Journal, and evidence evaluation remain the execution boundaries.

## Composition and precedence

`apps/cli/src/model-context.ts` owns the application recipe. Blocks keep stable IDs and are emitted in this
order:

| Block | Role | Required | Decision supported |
| --- | --- | --- | --- |
| `constitution:core` | `system` | yes | Apply cross-Tool safety and evidence rules |
| `mode:<mode>` | `system` | yes | Choose Ask, Plan, or Agent behavior |
| `capabilities` | `system` | yes | Stop or choose a feasible action from coarse frozen grants |
| `host:environment` | `system` | yes | Choose direct argv, a probed script profile, or no host execution |
| `workspace:AGENTS.md` | `user` | Plan / write-capable Agent | Apply repository operating instructions inside Runtime policy |
| `memory:context` | `user` | no | Reuse relevant accepted claims as reference data |
| `skills:index` | `user` | no | Preserve progressive discovery while budget remains |
| `skills:<scope>:<name>` | `user` | no | Decide whether one Skill is relevant enough to load |

The current user input follows compiled blocks. Workspace, Memory, Skill, fetched, and Tool-result content cannot
override Runtime policy or grant capabilities. XML-like envelopes escape authored delimiters; Memory exposes only
coarse scope kind, layer, activation, and statement. Root `AGENTS.md` includes a digest so operators can correlate
the exact bounded document without disclosing a host path.

## Workspace and host disclosure

Only a regular, non-symlink root `AGENTS.md` of at most 64 KiB is eligible. An absent file means there is no
repository contract. An unsafe present file is ignored in Ask and fails closed before Plan or a write-capable
Agent Run reaches the model.

Read-only mounts disclose `mount:<id>` and `read`; absolute host paths remain outside model context. Shell
profiles disclose coarse probe state. Credentials, internal authority traces, provider transport state, and
Session/Run/Step/Action IDs are not part of this recipe.

## Budget and omission

The TurnLoop uses one `TokenEstimator` for ContextBlocks, portable messages, and Tool schemas. The default
estimator is intentionally conservative for non-ASCII text and includes message/schema framing; a ModelPort may
return a model-calibrated estimator through `ModelCapabilities`.

Allocation reserves current input, required blocks, final-handoff control, and the actual advertised Tool catalog
before selecting whole restored turns. Optional Workspace, Memory, and Skill blocks are then selected
deterministically by priority. Old turns and optional omission hints may yield under pressure. Formal Plan
Executors continue to use `historyBudgetTokens: 0`.

`context.compiled` records IDs, budgets, and aggregate kind/token statistics, never block payloads. Provider usage
may calibrate estimators offline but does not rewrite Session truth.

## Regression evidence

`tests/model-context.test.mjs` and `fixtures/model-context/prompt-blocks.json` freeze roles, ordering, required
status, priority, and content digests for Ask, Plan, and Agent. Context allocation and estimator behavior live in
`tests/llm-context.test.mjs` and `tests/turn-loop.test.mjs`. Provider adapter tests prove portable message order is
preserved on both supported wire APIs.
