# Graph Governor

A graph reduces the model's current choice set. It is useful when deterministic state and policy can bound the
next decision, but it must not become a second Kernel or capability system.

## Route precedence

1. Validate the active graph and current node.
2. Evaluate deterministic guards from observable state.
3. If exactly one deterministic route matches, take it without model sampling.
4. Otherwise offer only explicit model-choice edges from the current node.
5. Reject any returned choice outside that set.

The node also narrows the advertised tools for the next Step. Normal registry and capability checks still apply.

## Dynamic replacement

A proposed replacement is untrusted structured input. Validate graph shape, node/edge references, guard kinds,
and entry node; then obtain independent authority to replace the active graph. Failure leaves the current graph
unchanged.

## Design test

If a routing condition can be computed deterministically, encode it as a guard rather than asking a model. If the
choice requires interpretation, offer a small explicit set with descriptions and retain the chosen edge as
explainable evidence.

See `tests/graph-governor.test.mjs`.
