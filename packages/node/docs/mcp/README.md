# `@civaapple/qi-node/mcp`

A quarantine and binding boundary between MCP discovery and Qi's authorized Tool Registry.

## Purpose

`McpDeclarationCatalog` reads inert declarations from `.qi/mcp/*.{toml,json}` and
`$QI_HOME/resources/mcp/` (top-level files plus one marketplace subdirectory level, e.g.
`$QI_HOME/resources/mcp/claude-plugins-official/context7.json`). Nested marketplace directories qualify the
server id as `name@marketplace` (and set `declaration.marketplace`) so they coexist with workspace
`.qi/mcp/<name>.toml` and flat user declarations. Workspace short names still shadow flat user short names.
`McpConnectionManager` wraps the pinned
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
- stdio declarations may use `npx` or `uvx` for registry-published servers; exact package versions are
  recommended, while floating selectors are accepted as an explicit operator choice.
- Discovery enumerates only capability classes advertised by the server; tool-only servers do not fail because
  Resources, Resource Templates, or Prompts are absent.
- Binding is explicit and schema-aware.
- Each invocation receives a fresh capability decision.
- Reconnect/list-changed fingerprint drift disables new calls until re-review.
- stdio requires Execute plus the business effect; HTTP/SSE requires Network plus the business effect.
- Spend leases have one use; Publish and Spend default disabled.
- Oversized output becomes an Artifact reference instead of unbounded context.
- Image blocks in live MCP results are stored as Artifacts and returned to the model as tool-result `artifact`
  parts for the current Run. They are not Session attachments and do not enter `read_image` authority.
- An empty or unmatched `mcp_catalog` search returns an explicit hint; agents must not invent MCP servers or use
  MCP to view local Workspace/Session images.

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

An npm-published stdio server can be declared without a global install:

```toml
transport = "stdio"
command = "npx"
args = ["-y", "@playwright/mcp@0.0.78"]
```

A Python-published server can use the equivalent JSON declaration at `.qi/mcp/fetch.json`:

```json
{
  "transport": "stdio",
  "command": "uvx",
  "args": ["mcp-server-fetch"]
}
```

The human-triggered refresh may resolve, download, and execute the declared registry package. Qi fingerprints
the resolved launcher and complete argv, but a floating selector can still resolve to new code without the
declaration changing. Refresh and re-review after intentional upgrades.

## Public API

The legacy `McpBridge`, production declaration/review/connection managers, proxy Tools, sealed OAuth provider,
fingerprint helpers, and MCP types.

## Change guide

Treat every new transport as untrusted input. Preserve quarantine and require an explicit resource/effect mapping
before registry exposure.

## Verification

`tests/mcp-bridge.test.mjs` covers the portable bridge. `tests/skills-mcp-production.test.mjs` covers declaration
isolation, drift, exact resources, sealed OAuth, schemas, tool-only discovery, and all three transports with local
servers.

## Further reading

- [Trust boundary](trust-boundary.md)
- [Tool execution contract](../tools/execution-contract.md)
