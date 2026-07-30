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
| `./media` | image URL/clipboard ingestion, MIME/magic validation, preprocessing, Artifact storage, and `read_image` |
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
  state/{continuity.sqlite,memory.sqlite}
  credentials/{master.key,store.json}
  resources/{skills,prompts,themes,agents,workflows,mcp}/
  packages/{installed.toml,lock.json,store,cache,staging}/
  projects/<workspace-name>-<path-hash>/
    project.json
    policy.toml
    state/{qi.sqlite,effects.sqlite,memory.sqlite,scheduler.sqlite}
    artifacts/ plans/<plan-id>/<sha256>.md tasks/ packages/activation.json cache/ tmp/
```

Project `memory.sqlite` indexes only that project's Session/Project claims. The fixed local-user Continuity
Session in `state/continuity.sqlite` is the global fact stream for explicitly confirmed User Memory, projected
into `state/memory.sqlite`. Both indexes are versioned, transactional, and rebuildable from their event streams;
claim text is plaintext inside these machine-private databases.

`projectPaths()`, `ensureQiLayout()`, and `ensureProjectLayout()` are the only path/layout implementation used
by CLI and Web. Existing non-empty pre-0.6 homes fail without migration or deletion. Private roots cannot be
filesystem roots, Workspace descendants, symlinks, junction traversals, or path escapes.

Workspace `.qi` is separate: it contains only allowlisted declarations and package locks. Ordinary Agent file
tools still deny `.qi`; dedicated services validate types, size, secrets, executables, and symlinks before
atomic writes.

Formal Plan revisions are stored at immutable content-hash paths under the machine-private project root.
Ordinary file tools cannot read or edit that directory; `plan_document read/edit` is the bounded access path.

Image ingestion supports PNG, JPEG, GIF, and WebP with a 64 MiB source limit and 100 MP decode guard. The default
prepared view is bounded to a 2000 px longest edge and 3.75 MiB; transparent images stay PNG, JPEG encoding uses
quality/size ladders, and animated GIF/WebP passes only when already within limits. Both original and prepared
bytes are content-addressed under project `artifacts/`. Public URL reads reuse DNS pinning, private/local denial,
default ports, redirect/HTTPS policy, cancellation, and timeout rules while retaining a separate image byte
budget from the 1 MiB text `fetch` Tool.

`SqliteEventStore` keeps a non-persistent, version-checked projection cache for the running process. Normal
append validates only the new batch and advances that cache inside the existing transaction; restart, version
mismatch, validation failure, or rollback rebuilds from the immutable stream. The cache changes no database
schema or recovery semantics.

## Declaration-only packages

`DeclarativePackageStore` accepts exact npm versions with registry integrity, Git URLs pinned to a 40-character
commit, or local directories hashed by content. It downloads/checks out into staging, never runs npm lifecycle
scripts, validates the tree and manifest, then publishes immutable content to `packages/store/sha256-*`.
Resource registration does not grant authority. Executable third-party plugins are outside the 0.6 contract.

Detailed adapter contracts live under [`docs/`](docs/).
