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
| `./skills` | progressive Agent Skills, immutable source locks, full resource trees, and bounded script execution |
| `./mcp` | inert declarations, official transports, quarantined fingerprint review, sealed OAuth, and proxy Tools |
| `./plugins` | Claude-compatible marketplace sync, pinned plugin cache, plugin Skill Tool, `/plugin:` and `/agent:` catalogs (ADR-0037) |
| `./sandbox` | graded process sandbox port (ADR-0041): srt preferred → Windows Low IL → host; wraps shell/script/verify/skill-script and MCP stdio children |
| `./codeact` | container-isolated short programs with ordinary nested Tool authority |
| `./scheduler` | bounded durable timer/event watchers |
| `./stream` | committed catch-up/live delivery and SSE |
| `./extensions` | declaration validation and npm/Git/local content-addressed package installation |

Process sandbox selection is `auto` by default. Full srt isolation maps the Workspace to allowWrite and
Session-authorized **read-only mounts** to allowRead; path guards still deny `.qi` / `.git` / `.artifacts`
and host secret roots. Successful srt smoke is cached for the Node process lifetime; Windows srt backends
may `prewarm()` ACL grants for common tool binaries. See
[ADR-0041](../../design/decisions.md#adr-0041-graded-process-sandbox-srt--windows-low-il--host).

## Private layout

Qi 0.6 uses layout generation 2. Project layout version 2 stores each Session as a movable directory
([ADR-0030](../../design/decisions.md#adr-0030-make-session-directories-the-movable-persistence-boundary)):

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
    state/{memory.sqlite,scheduler.sqlite}
    sessions/<session-id>/
      state/{qi.sqlite,effects.sqlite}
      artifacts/ plans/<plan-id>/<sha256>.md tasks/
    archives/<session-id>/
      state/{qi.sqlite,effects.sqlite}
      artifacts/ plans/ tasks/
      archive.json
    packages/activation.json cache/ tmp/
```

Legacy project roots that still expose a shared `state/qi.sqlite` or project-level `artifacts/`, `plans/`, or
`tasks/` are rejected without migration. Back up the old project directory and start from a new data root, or
clear the incompatible project folder after backup.

Project `memory.sqlite` indexes only that project's **active** Session/Project claims. The fixed local-user Continuity
Session in `state/continuity.sqlite` is the global fact stream for explicitly confirmed User Memory, projected
into `state/memory.sqlite`. Both indexes are versioned, transactional, and rebuildable from their event streams;
claim text is plaintext inside these machine-private databases. CLI startup applies incremental catch-up
(`lastAppliedSequence` / `retainOriginSessions`) instead of wiping the project index on every launch.

`projectPaths()`, `ensureQiLayout()`, `ensureProjectLayout()`, and `SessionRepository` are the path/layout and
Session catalog surface used by CLI and Web. Existing non-empty pre-0.6 homes fail without migration or deletion.
Private roots cannot be filesystem roots, Workspace descendants, symlinks, junction traversals, or path escapes.

Workspace `.qi` is separate: it contains only allowlisted declarations and package locks. Ordinary Agent file
tools still deny `.qi`; dedicated services validate types, size, secrets, executables, and symlinks before
atomic writes.

Formal Plan revisions are stored at immutable content-hash paths under the machine-private project root.
Ordinary file tools cannot read or edit that directory; `plan_document read/edit` is the bounded access path.

The `artifact` Tool also writes only to the machine-private project store. Its mutation resource includes the
content digest (`artifact-store:local:<sha256>`), so distinct content-addressed writes in one Step do not conflict;
the capability lease remains bounded by `artifact-store:local:**`. An Artifact reference is not a Workspace file
mutation or evidence that an implementation task was completed. Read-effect `artifact_get` loads store content by
`artifact://` ref (for example a Subagent `resultRef`); workspace `read` rejects `artifact://` paths.

Image ingestion supports PNG, JPEG, GIF, and WebP with a 64 MiB source limit and 100 MP decode guard. Sources are
clipboard bytes, Network-authorized public HTTP(S) URLs, and Workspace/mount file paths (absolute paths under an
authorized root are rewritten to relative or `mount:<id>/…` before resolution). The default prepared view is
bounded to a 2000 px longest edge and 3.75 MiB; transparent images stay PNG, JPEG encoding uses quality/size
ladders, and animated GIF/WebP passes only when already within limits. Both original and prepared bytes are
content-addressed under the owning Session's `artifacts/`. Public URL reads reuse DNS pinning, private/local
denial, default ports, redirect/HTTPS policy, cancellation, and timeout rules while retaining a separate image
byte budget from the 1 MiB text `fetch` / `web_map` Tools.

`SqliteEventStore` keeps a non-persistent, version-checked projection cache for the running process. Normal
append validates only the new batch and advances that cache inside the existing transaction; restart, version
mismatch, validation failure, or rollback rebuilds from the immutable stream. The cache changes no database
schema or recovery semantics. Catalog listing and `SessionRepository.recover()` use `peekLifecycle` / cheap SQL
titles so cold start does not full-replay every Session; cold replay remains the `SessionView` oracle.

## Declaration-only packages

`DeclarativePackageStore` accepts exact npm versions with registry integrity, Git URLs pinned to a 40-character
commit, or local directories hashed by content. It downloads/checks out into staging, never runs npm lifecycle
scripts, validates the tree and manifest, then publishes immutable content to `packages/store/sha256-*`.
Resource registration does not grant authority. Plugin Skills remain untrusted context; hooks, lifecycle entrypoints,
visual companion servers, and dependency installers are outside the Qi contract. Superpowers can be installed from
either its self marketplace or `claude-plugins-official` (sync/reinstall allowed; bootstrap requires structural
`using-superpowers` path checks), with only one same-name marketplace enabled at a time.

Detailed adapter contracts live under [`docs/`](docs/).
