# Evidence-backed completion

A Goal is a completion contract, not a prompt string. It names assertions that must be evaluated and the evidence
required to trust a terminal `complete` state.

## Completion chain

```text
Goal assertion
  <- Evaluation(pass)
  <- Evidence with matching assertion, kind, provenance, and trusted status
```

A passing evaluator report without matching ledger evidence is insufficient. Evidence for a different assertion
cannot be reused merely because its text sounds related.

## Evidence kinds

- Deterministic: schema, state, or calculation whose rule is reproducible.
- Behavioral: a test or observed execution trace.
- Semantic: model or human-like judgment subject to calibration.
- Human: an explicit person decision or acceptance.

Each record retains source, artifact or event references, evaluator identity, and creation context.

## Unknown is useful

`unknown` means the system cannot currently make a trustworthy pass/fail judgment. It preserves uncertainty and
can request evidence, calibration, or human input. It must never be coerced to pass to unblock orchestration.

`tests/goal-eval.test.mjs` proves matching evidence and trusted completion; `tests/slice0.test.mjs` proves unknown
evidence cannot verify a Goal.
