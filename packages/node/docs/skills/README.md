# `@civaapple/qi-node/skills`

Safe progressive loading of declarative Skills and Agent definitions from the filesystem.

## Purpose

This package discovers lightweight metadata first and loads full instructions or resources only when selected.
It treats repository content as data, not executable authority.

## Non-goals

- A Skill never grants capabilities by being installed or mentioned.
- Agent definitions are not runtime JavaScript plugins.
- Discovery does not recursively ingest every referenced file into context.

## Core model

`SkillLoader` validates roots, frontmatter, metadata, and progressively disclosed content. `SkillCatalog` merges
the Workspace `.qi/skills` scope with the user `$QI_HOME/resources/skills` scope; a same-named Workspace Skill wins.
Agent definitions are parsed declaratively. Shared frontmatter helpers enforce required fields without evaluating
source code. `version` is optional and projects as `unversioned` when absent.

Qi directly enables Workspace `<workspace>/.agents/skills` as a read-only active Skill source. Global
`~/.agents/skills` is listed from `.skill-lock.json` metadata at startup but requires explicit human activation;
activation state is stored under `$QI_HOME/resources` and is bound to the lock entry hash. Activated global Skills
then use the normal Skill Tool, while the source directory remains unchanged. Every catalog refresh reconciles this
state with the external lock file, automatically removing activations whose lock entry was removed or changed. An
already-running Run keeps its immutable loaded context; later Runs fail closed. Qi roots have higher precedence and
can be used as optional content-addressed snapshots. `discoverCompatibility()` remains metadata-only for other configured roots such as
`~/.codex/skills` and `~/.claude/skills`, which are not scanned by default and require an explicit local path or
configured compatibility root before inspection or installation.

The TUI completes active Skill names after `/skill:`; the completed `/skill:<name>` command still requires a task
before starting a Run. `/skills` → **Always-on Skills** lists Workspace and user Qi Skills (plus workspace
`.agents` Skills) that need no activation toggle; global `~/.agents/skills` remain under **Enable / disable global
Skills**. When the Workspace is the user's home directory, the overlapping `.agents/skills` path is
kept behind the global lock and activation state rather than being treated as a directly active project root.

## Behavioral invariants

- Missing or invalid frontmatter fails closed.
- Skill roots that are symbolic links are rejected at the trust boundary.
- Agent definition files are read as declarations and never executed.
- Full resources remain unloaded until explicitly requested.
- Installation copies the complete bounded ordinary-file tree through a sibling staging directory and atomic rename.
- Installation never follows symbolic links, overwrites an existing Skill, or grants runtime capabilities.
- Workspace updates require an exported ordinary-directory draft plus a fresh digest, and retain recovery state
  when atomic publication cannot be confirmed.

## Failure semantics

Invalid roots, metadata, or definitions produce structured loader errors before content enters context. A load
failure does not fall back to executing or trusting the file.

## Install and minimal use

```sh
npm install @civaapple/qi-node/skills
```

```ts
import { parseFrontmatter } from "@civaapple/qi-node/skills";

const parsed = parseFrontmatter(
  "---\nname: explain\ndescription: Explain a repository\n---\nRead the smallest relevant files.",
  "Example Skill",
);
```

## Public API

`SkillLoader`, `SkillCatalog`, skill metadata/result types, agent definition types, and frontmatter parsing helpers.

`SkillCatalog.install()` accepts an explicit local directory or a bare name found under configured compatibility
 roots such as a caller-configured `~/.codex/skills` (including `.system/<name>`). It has no implicit network registry. User scope is
the API default; callers must request Workspace scope explicitly. Installing a compatibility candidate is a
copy-and-validate migration; the source directory remains unchanged.

`SkillCatalog.remove(name, { scope? })` is the human-operated inverse for Qi-managed trees only
(`$QI_HOME/resources/skills` and `<workspace>/.qi/skills`). It deletes the Skill directory and drops the matching
lock entry; it never touches global or project `.agents` roots. When the same name exists in both scopes, callers
must pass `scope`. `listManagedSkills()` returns every removable Qi copy across both scopes.

Human-operated `installImmutable()` additionally accepts an exact Git/GitHub commit or an HTTPS tar archive with
SHA-256. It rejects floating identities, redirects, lifecycle execution, links, special files, non-portable paths,
and trees above 512 files / 8 MiB per file / 64 MiB total / depth 16. Provenance and the content-tree digest are
recorded in `.qi/skills.lock.json` or `$QI_HOME/resources/skills.lock.json`.

For the common `skills/<name>` repository layout, `installGithubSkill(url, name)` is the human-operated
convenience equivalent of `npx skills add <url> --skill <name>`: it resolves GitHub `HEAD` once to an exact commit,
uses a sparse checkout of the declared Skill directory, and then calls the same immutable install path. A caller
may provide a different contained subdirectory. This API is never exposed to model-operated installation.

`compatibility`, `allowed-tools`, and `metadata["qi.required-*"]` produce readiness diagnostics only. Unknown
frontmatter is retained as informational extension data. `runSkillScript()` accepts only regular `scripts/**`
files, bounded argv/cwd/timeout, and frozen interpreter profiles; it never installs dependencies or supplies
provider/MCP credentials.

Claude-compatible plugin Skills are intentionally a separate catalog. They are available only after the plugin
and the individual Skill have been enabled, and only when upstream metadata permits model invocation; explicitly
selected user-only Skills enter a Run through `/skill:<marketplace>:<plugin>:<skill>`. They do not appear in the
native `/skills` catalog or acquire authority from plugin metadata. Plugin Skill resources are read from the
pinned immutable cache, and extensionless scripts must declare the exact `#!/usr/bin/env bash` interpreter line.

`exportWorkspaceDraft()` and `updateWorkspace()` are the create-draft/update pair for existing Workspace Skills.
They do not weaken the generic `.qi` file boundary; callers must still provide effect and path authority.

## Change guide

Keep discovery cheap and loading explicit. New metadata fields must define validation and whether they affect
selection, context, or only presentation; none may imply authority.

## Verification

`tests/skills-agent.test.mjs` and `tests/skills-mcp-production.test.mjs` cover progressive disclosure, scope
precedence, full trees/binary resources, locks, scripts, unsafe paths, and six pinned real-world samples.

## Further reading

- [Loading security](loading-security.md)
- [Skill and extension design](../../../../design/system-design.md#8-extensions-skills-mcp-codeact-graph-delegation-scheduling-and-introspection)
