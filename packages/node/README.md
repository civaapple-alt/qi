# @civaapple/qi-node

Concrete Node.js adapters for Qi's portable Agent boundaries.

```sh
npm install @civaapple/qi-node @civaapple/qi-agent @civaapple/qi-protocol
```

```ts
import * as qiNode from "@civaapple/qi-node";
import { projectPaths } from "@civaapple/qi-node/paths";
import { SqliteEventStore } from "@civaapple/qi-node/storage";

void qiNode.QI_LAYOUT_GENERATION;
```

Controlled entrypoints:

| Entry | Responsibility |
| --- | --- |
| `./paths` | `$QI_HOME`, canonical project IDs, project-private paths, layout initialization, Web discovery |
| `./storage` | SQLite Session and Memory stores plus encrypted credential-file storage |
| `./workspace` | local/container/worktree/process adapters and SQLite EffectJournal |
| `./tools` | filesystem, Git, Shell, Verify, Network, and Artifact Tool implementations |
| `./skills` | declaration-only Skill/Agent loading and dedicated Skill writes |
| `./mcp` | quarantined MCP discovery and explicit binding |
| `./codeact` | container-isolated short programs with ordinary nested Tool authority |
| `./scheduler` | bounded durable timer/event watchers |
| `./stream` | committed catch-up/live delivery and SSE |
| `./extensions` | declaration validation and npm/Git/local content-addressed package installation |

## Private layout

Qi 0.6 uses layout generation 2:

```text
$QI_HOME/
  layout.json
  config.toml
  credentials/{master.key,store.json}
  resources/{skills,prompts,themes,agents,workflows,mcp}/
  packages/{installed.toml,lock.json,store,cache,staging}/
  projects/<workspace-name>-<path-hash>/
    project.json
    policy.toml
    state/{qi.sqlite,effects.sqlite,memory.sqlite,scheduler.sqlite}
    artifacts/ plans/ tasks/ packages/activation.json cache/ tmp/
```

`projectPaths()`, `ensureQiLayout()`, and `ensureProjectLayout()` are the only path/layout implementation used
by CLI and Web. Existing non-empty pre-0.6 homes fail without migration or deletion. Private roots cannot be
filesystem roots, Workspace descendants, symlinks, junction traversals, or path escapes.

Workspace `.qi` is separate: it contains only allowlisted declarations and package locks. Ordinary Agent file
tools still deny `.qi`; dedicated services validate types, size, secrets, executables, and symlinks before
atomic writes.

## Declaration-only packages

`DeclarativePackageStore` accepts exact npm versions with registry integrity, Git URLs pinned to a 40-character
commit, or local directories hashed by content. It downloads/checks out into staging, never runs npm lifecycle
scripts, validates the tree and manifest, then publishes immutable content to `packages/store/sha256-*`.
Resource registration does not grant authority. Executable third-party plugins are outside the 0.6 contract.

Detailed adapter contracts live under [`docs/`](docs/).
