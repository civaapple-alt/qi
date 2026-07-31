# `@civaapple/qi-agent/eval`

Goal contracts, evidence-backed completion, evaluator calibration, and repeated-failure convergence.

## Purpose

This package prevents confidence from becoming completion. `GoalEngine` persists assertions, evaluations,
evidence, resource pressure, and control receipts. Evaluators produce `pass`, `fail`, or `unknown` under an
explicit trust model.

## Non-goals

- It does not execute corrective actions.
- A semantic judge is not trusted merely because it returned a confident answer.
- Resource exhaustion is not silently converted into task failure or success.

## Core model

A Goal contains assertions and completion policy. Evidence is typed and linked to an assertion. Deterministic
evaluators can provide direct results; semantic evaluators require calibrated identity. Failure fingerprints
normalize equivalent failures so stagnation can force strategy change or parking.

## Behavioral invariants

- Completion requires passing assertions backed by matching ledger evidence.
- Uncalibrated semantic results remain recorded but project to `unknown`.
- Judge identity includes kind, model/provider reference, prompt, rubric, toolchain, and version boundary.
- Equivalent repeated failures trip stagnation despite volatile IDs, timestamps, or stack lines.
- Resource exhaustion enters convergence and pauses rather than pretending completion.

## Failure semantics

`fail` means evaluated evidence disproves an assertion; `unknown` means trustworthy judgment is unavailable.
Budget exhaustion, judge mistrust, and stagnation are control states rather than ordinary executor errors.

## Install and minimal use

```sh
npm install @civaapple/qi-agent/eval
```

```ts
import { failureFingerprint } from "@civaapple/qi-agent/eval";

const fingerprint = failureFingerprint({
  assertionId: "assert_tests",
  evaluatorIdentity: "deterministic:test",
  errorCode: "TEST_FAILED",
  targetResources: ["workspace:tests"],
});
```

## Public API

`GoalEngine`, evaluator interfaces and implementations (`DeterministicEvaluator`, `SemanticEvaluator`,
`HumanEvaluator` / `HumanEvalInput`), `EvaluatorCalibrationRegistry`, and `failureFingerprint()`.

## Change guide

Any new evidence or evaluator type must define provenance, trust, replay, and completion impact. Update Kernel
projection and goal tests before exposing it to the loop or UI.

## Verification

`tests/goal-eval.test.mjs` covers completion, calibration, pressure, and stagnation.
`tests/goal-continuation.test.mjs` covers Session-local Run binding and post-Run continuation decisions.

## Further reading

- [Evidence-backed completion](docs/evidence-completion.md)
- [Judge calibration](docs/judge-calibration.md)
- [Eval design](../../design/system-design.md#6-goals-evidence-and-completion)
