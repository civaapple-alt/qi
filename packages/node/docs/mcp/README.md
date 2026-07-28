# `@civaapple/qi-node/mcp`

A quarantine and binding boundary between MCP discovery and Qi's authorized Tool Registry.

## Purpose

`McpBridge` discovers remote tool metadata without making it executable. A separate explicit binding maps a
reviewed remote candidate into a local tool definition, with normal schema, capability, artifact, and settlement
controls.

## Non-goals

- MCP server availability or discovery does not imply trust.
- Remote descriptions do not grant local capabilities.
- The bridge does not bypass the Tool Registry or expose unlimited remote output to context.

## Core model

`McpTransport` lists and invokes remote tools. Discovery creates quarantined `McpToolCandidate` records. Only an
explicit `McpToolBinding` enters the local catalog, where every call is independently authorized.

## Behavioral invariants

- Discovered tools are inert until bound.
- Binding is explicit and schema-aware.
- Each invocation receives a fresh capability decision.
- Oversized output becomes an Artifact reference instead of unbounded context.

## Failure semantics

Discovery, binding, authorization, transport, remote execution, and output-size failures remain separate. A
remote failure never becomes a trusted local success.

## Install and minimal use

```sh
npm install @civaapple/qi-node/mcp
```

```ts
import { McpBridge } from "@civaapple/qi-node/mcp";

const bridge = new McpBridge("example", {
  async listTools() {
    return [];
  },
  async callTool() {
    throw new Error("No remote Tools are bound");
  },
});

console.log(await bridge.discover()); // [] — discovery alone registers nothing.
```

## Public API

`McpBridge` and the remote tool, transport, candidate, and binding interfaces.

## Change guide

Treat every new transport as untrusted input. Preserve quarantine and require an explicit resource/effect mapping
before registry exposure.

## Verification

`tests/mcp-bridge.test.mjs` covers quarantine, explicit binding, per-call authority, and Artifact fallback.

## Further reading

- [Trust boundary](docs/trust-boundary.md)
- [Tool execution contract](../tools/docs/execution-contract.md)
