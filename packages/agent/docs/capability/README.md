# `@civaapple/qi-agent/capability`

Default-deny capability leases, narrowed delegation, policy traces, and opaque credential handles.

## Purpose

This package decides whether a specific subject may perform a described effect on bounded resources for a
particular intent and time. It makes authority visible, expiring, countable, and delegable only by narrowing.

## Non-goals

- Tool schemas and discovery do not grant capabilities.
- The broker never executes tools or exposes raw credentials to model context.
- A child Agent cannot infer or widen parent authority.

## Core model

An `ActionIntent` is checked against a `CapabilityLease` covering subject, effects, resources, lifetime, and use
limits. Optional frozen Run `mode` (`ask` / `plan` / `agent`) may only narrow matches via `mode-policy`
([ADR 0011](../../design/decisions.md#adr-0011-make-human-control-and-askplanagent-modes-durable)); it never invents authority beyond leases.

**Permission mode** (`manual` / `yolo` / `auto`, [ADR-0040](../../design/decisions.md#adr-0040-permission-mode-manual--yolo--auto-orthogonal-to-session-mode))
is orthogonal: it selects the coding lease pack and whether in-lease non-read Actions auto-accept or require
human Once/Session/Project approval (`approval-policy`). It never widens past leases or Session mode. Host
children use the graded process sandbox ([ADR-0041](../../design/decisions.md#adr-0041-graded-process-sandbox-srt--windows-low-il--host)).

Delegation intersects the requested child scope with the parent. `CredentialHandle` binds secret access to
subject and intent while the secret stays behind the broker.

`redactSensitiveText()` and `redactSensitiveValue()` provide a last-resort literal scrubber for extremely
high-confidence credential shapes (provider tokens, URL userinfo, PEM blocks). `Authorization: Bearer` values
are left intact so agents can reuse tokens while debugging services they create. Sensitive Workspace paths are
gated by human content grants before file bodies reach the model; ordinary authorized reads round-trip as raw
text for precise edit.

## Behavioral invariants

- Deny by default when no current lease matches the complete intent.
- Mode policy denies Ask/Plan-forbidden tools and effects even when a broader launch lease exists.
- Permission mode yolo/auto auto-accepts only after Session mode and lease checks; Ask+yolo cannot write.
- Manual approval memory is pattern-scoped (Once does not persist); mount/MCP bind remain authority expansion.
- Lease expiry and use limits are enforced independently of tool validation.
- Delegation only narrows scope and emits an inspectable policy trace.
- Credential material is not serialized into Session, context, or tool catalogs.
- Hard path/sandbox denials fail closed without “approve danger” prompts under yolo/auto.
- Extremely high-confidence credential literals (provider tokens, PEM blocks, URL userinfo) may still be
  redacted before provider reuse or durable persistence; `Authorization: Bearer` values and source-code
  assignment forms are not rewritten.

## Failure semantics

Authorization returns a structured allow or deny decision. Callers persist denials as outcomes and must not
enter an executor. Missing, expired, exhausted, or mismatched leases remain distinguishable in policy evidence.

## Install and minimal use

```sh
npm install @civaapple/qi-agent/capability
```

```ts
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";

const broker = new InMemoryCapabilityBroker();
const decision = await broker.authorize({
  actionId: "act_example",
  subject: "main-agent",
  tool: "read",
  effect: "read",
  resources: ["workspace:file:README.md"],
});
// decision.outcome is "denied" until an explicit matching lease is granted.
```

## Public API

`CapabilityBroker`, `InMemoryCapabilityBroker`, lease and intent types, delegation types,
`InMemoryCredentialBroker` (including `withCredential`), `EncryptedFileCredentialStore`, and deterministic
redaction utilities.

## Change guide

New effect classes or resource matching rules require denial tests, delegation monotonicity tests, and updates
to tool and coordinator integration. Never make authorization depend only on a tool name.

## Verification

Use `tests/tools-capability.test.mjs`, `tests/permission-approval.test.mjs`, `tests/workspace-safety.test.mjs`,
and `tests/coordinator.test.mjs`.

## Further reading

- [Lease model](lease-model.md)
- [Credential handles](credential-handles.md)
- [Safety design](../../design/system-design.md#4-workspace-authority-and-effects)
- [ADR-0040](../../design/decisions.md#adr-0040-permission-mode-manual--yolo--auto-orthogonal-to-session-mode)
- [ADR-0041](../../design/decisions.md#adr-0041-graded-process-sandbox-srt--windows-low-il--host)
