# Capability lease model

A capability lease is a temporary, scoped answer to “who may do what, to which resources, for which intent,
until when, and how many times?” It is not a global role or a tool allowlist.

## Decision inputs

An `ActionIntent` identifies subject, effect, tool, resources, and intent. Authorization requires a current lease
whose complete scope covers that request. A partial match is a denial.

## Scope dimensions

- Subject: the Session or delegated child using the authority.
- Effect: read, write, execute, publish, or spend.
- Resource: the concrete file, tree, process, service, or bounded target.
- Intent: why this authority was granted.
- Time: issue and expiry boundary.
- Usage: optional maximum invocation count.

## Delegation

A delegated lease is the intersection of the parent's remaining authority and the requested child scope. The
result may be narrower but never wider. A policy trace explains removed effects or resources.

```text
child authority ⊆ requested authority ⊆ parent authority
```

## Enforcement order

Tool input validation identifies the proposed operation; the broker then decides authority; durable grant and
Action start events precede executor entry. A denied decision is persisted and returned as feedback.

Tests in `tests/tools-capability.test.mjs` and `tests/coordinator.test.mjs` prove default denial, expiry, use limits,
and delegation monotonicity.
