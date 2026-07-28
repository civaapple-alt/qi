# `@civaapple/qi-codeact`

Sandboxed short programs whose nested actions still pass through Qi's normal tool controls.

## Purpose

CodeAct lets a model express compact control logic as a staged program while `ControlledToolClient` routes every
nested action through durable authority, lifecycle, registry, and effect boundaries.

## Non-goals

- CodeAct is not a privileged escape hatch around tools.
- Generated programs do not receive ambient host filesystem, network, or credentials.
- A container plan is not reported as executed when the runtime is unavailable.

## Core model

`CodeActRunner` runs a program through a `ProgramSandbox`. `ContainerProgramSandbox` stages only the selected
program — from either a `programFile` path or inline `programSource`, staged and cleaned up identically either
way — and builds a network-off, read-only-root invocation. `ControlledToolClient` converts nested calls into
normal durable Actions, optionally narrowed by an `allowedTools` allowlist. `probeContainerRuntime()` detects
whether a `docker` or `podman` runtime actually responds before a caller registers container-backed capability.

## Behavioral invariants

- Every nested tool call has its own authority and result events.
- Denial never enters the nested executor.
- Only staged code is mounted into the program sandbox, regardless of whether it came from a file or inline source.
- Network and writable root access are disabled by default.
- When `allowedTools` is set, a name outside it fails closed as `TOOL_NOT_ALLOWED` before any inspection or Session
  event, independent of what the subject's capability leases would otherwise authorize.
- A container-backed capability is registered only after `probeContainerRuntime()` observes a real response; an
  unavailable runtime never silently degrades to a fake success.

## Failure semantics

Program failure, nested tool denial, nested executor failure, sandbox unavailability, and indeterminate effects
remain distinct. The outer program cannot mask an unsettled nested action.

## Install and minimal use

```sh
npm install @civaapple/qi-codeact
```

```ts
import { buildContainerInvocation } from "@civaapple/qi-codeact";

const plan = buildContainerInvocation(
  { runtime: "docker", image: "node:24-alpine" },
  "/staged/program",
);
console.log(plan.args.includes("--network"), plan.args.includes("--read-only"));
```

## Public API

`CodeActRunner`, `ControlledToolClient`, program sandbox ports, fixture sandbox, container sandbox helpers, and
`probeContainerRuntime`.

## Change guide

New sandbox features need an explicit threat model. Preserve nested Action identity and ensure resource access is
both isolated by the workspace and authorized by a lease.

## Verification

`tests/codeact.test.mjs` covers nested durability, denial, and constrained container plans.

## Further reading

- [Sandbox contract](docs/sandbox-contract.md)
- [Tool execution contract](../tools/docs/execution-contract.md)
