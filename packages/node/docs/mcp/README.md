# `@civaapple/qi-node/mcp`

A quarantine and binding boundary between MCP discovery and Qi's authorized Tool Registry.

## Purpose

`McpDeclarationCatalog` reads inert declarations from `.qi/mcp/*.toml` and
`$QI_HOME/resources/mcp/*.toml`; Workspace names shadow user names. `McpConnectionManager` wraps the pinned
official client for stdio, Streamable HTTP, and explicitly selected legacy SSE. Discovery snapshots Tools,
Resources, Resource Templates, Prompts, and server instructions without making any executable.

## Non-goals

- MCP server availability or discovery does not imply trust.
- Remote descriptions do not grant local capabilities.
- The bridge does not bypass the Tool Registry or expose unlimited remote output to context.

## Core model

`McpReviewStore` fingerprints normalized remote metadata in machine-private project state. A human binding fixes
server, kind/name, fingerprint, effect (`read/write/execute/publish/spend`), and exact resources. Models see one
cached `mcp_catalog` and one Agent-only live `mcp` proxy instead of one Tool schema per remote capability.

Bindings are project-scoped and survive Session creation and Runtime restart. They are stored under the project
private root (`$QI_HOME/projects/<project-id>/state/mcp-bindings.json`), not in Workspace `.qi` and not in a
single Session's event stream. This persistent review state does not bypass fresh per-Run capability leases,
transport checks, or fingerprint drift checks.

The server's MCP `instructions` value is stored and fingerprinted as a separate review candidate. It is remote,
untrusted guidance and is never a Tool or an authority grant. Loading it requires an explicit `read` binding;
binding remote Tools does not implicitly bind server instructions. A server may therefore show some bound Tools
while its server-level instructions remain quarantined.

## Behavioral invariants

- Declarations and discovered capabilities are inert until explicitly refreshed and bound.
- Binding is explicit and schema-aware.
- Each invocation receives a fresh capability decision.
- Reconnect/list-changed fingerprint drift disables new calls until re-review.
- stdio requires Execute plus the business effect; HTTP/SSE requires Network plus the business effect.
- Spend leases have one use; Publish and Spend default disabled.
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

The legacy `McpBridge`, production declaration/review/connection managers, proxy Tools, sealed OAuth provider,
fingerprint helpers, and MCP types.

## Change guide

Treat every new transport as untrusted input. Preserve quarantine and require an explicit resource/effect mapping
before registry exposure.

## Verification

`tests/mcp-bridge.test.mjs` covers the portable bridge. `tests/skills-mcp-production.test.mjs` covers declaration
isolation, drift, exact resources, sealed OAuth, schemas, and all three transports with local servers.

## Further reading

- [Trust boundary](trust-boundary.md)
- [Tool execution contract](../tools/execution-contract.md)
