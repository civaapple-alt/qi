# Convergence and stagnation

Budgets prevent unbounded cost, but a loop can still waste the entire budget by repeating the same ineffective
strategy. Convergence therefore combines resource pressure with repeated-failure detection.

## Failure fingerprint

The evaluator normalizes assertion identity, evaluator identity, error class, causal evidence, and affected
resources. Volatile timestamps, generated IDs, stack line numbers, and resource ordering do not create a false
new failure.

## Response to repetition

1. Record a short causal summary and archive raw output as an Artifact when useful.
2. When the equivalent fingerprint repeats, require a changed strategy or changed evidence request.
3. When the stagnation threshold is crossed, enter convergence.
4. Park the Run and pause the Goal with an explicit reason and control receipt.

## Resource envelope

Tokens, wall time, money, attempts, concurrency, context, risk, and attention are independent dimensions. A hard
limit stops new work even if other dimensions remain. Approaching a limit should favor evidence synthesis and a
safe handoff rather than one more speculative call.

For Session-local Goals, `attempts` are charged per Goal-bound Step that proposed a non-`read` Action (not per
model Step and not for pure research). The CLI freezes `attempts.limit` to the then-current Session `maxSteps`
when the Goal is created; `maxSteps` itself still caps every Step inside a single Run.

The model window, output reserve, and prompt working budget are separate values. A larger model window raises the
ceiling but does not authorize unbounded transcript retention; consumed tool exchanges still compact before the
hard boundary.

See `tests/goal-eval.test.mjs` for normalized fingerprints and convergence behavior.
