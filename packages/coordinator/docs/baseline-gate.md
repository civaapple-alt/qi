# Multi-Agent baseline gate

Coordination adds cost, latency, failure modes, and authority surface. It is enabled only when paired evaluation
shows a material advantage over a single responsible Agent with equivalent tools and budget.

## Paired trial

Compare both modes on the same target case and record:

- completion and evidence quality;
- resource cost and latency;
- number and severity of recovery events;
- human intervention and integration burden;
- authority exposed to child Sessions.

The gate policy defines the minimum relevant improvement and maximum acceptable regressions. More activity or
more agents is never itself a success metric.

## Runtime consequence

Without sufficient paired evidence, the decision remains disabled and orchestration uses the single-Agent path.
Gate approval should be scoped to the evaluated task class rather than treated as a permanent global feature flag.

Model, prompt, coordinator, or task-distribution changes can invalidate old evidence and require a new trial.
`tests/coordinator.test.mjs` covers the default-off decision.
