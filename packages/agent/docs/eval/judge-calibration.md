# Judge calibration

Semantic evaluators are components whose judgment quality must itself be evaluated.

## Evaluator identity

Calibration attaches to the implemented `SemanticEvaluatorIdentity`: kind, model/provider reference, prompt,
rubric, toolchain, and version. Changing one produces a different identity hash and does not inherit trust.

## Calibration process

1. An external evaluation workflow maintains labeled replay cases and runs the exact evaluator identity.
2. That workflow supplies true-pass, true-reject, false-pass, and false-reject counts plus measurement and expiry
   timestamps.
3. `EvaluatorCalibrationRegistry` records the report under the identity hash.
4. `status()` enforces minimum sample count, validity time, maximum false-pass rate, and maximum false-reject rate.

The package does not execute or store the labeled dataset itself; it validates and applies the resulting report.

## Runtime effect

The raw semantic report remains durable for inspection. If calibration is missing, expired, or below policy, its
trusted projection becomes `unknown`; it cannot contribute a verified pass or fail.

## Change checklist

Prompt edits, model upgrades, rubric changes, new task domains, or changed output parsing require recalibration.
Evidence-backed completion metrics must be interpreted alongside calibration coverage and error rate.

See the semantic evaluator cases in `tests/goal-eval.test.mjs`.
