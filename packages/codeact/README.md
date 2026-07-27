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
program and builds a network-off, read-only-root invocation. `ControlledToolClient` converts nested calls into
normal durable Actions.

## Behavioral invariants

- Every nested tool call has its own authority and result events.
- Denial never enters the nested executor.
- Only staged code is mounted into the program sandbox.
- Network and writable root access are disabled by default.

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

`CodeActRunner`, `ControlledToolClient`, program sandbox ports, fixture sandbox, and container sandbox helpers.

## Change guide

New sandbox features need an explicit threat model. Preserve nested Action identity and ensure resource access is
both isolated by the workspace and authorized by a lease.

## Verification

`tests/codeact.test.mjs` covers nested durability, denial, and constrained container plans.

## Further reading

- [Sandbox contract](docs/sandbox-contract.md)
- [Tool execution contract](../tools/docs/execution-contract.md)
