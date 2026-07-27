# `@civaapple/qi-skills`

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
the Workspace `.qi/skills` scope with the user `~/.qi/skills` scope; a same-named Workspace Skill wins.
Agent definitions are parsed declaratively. Shared frontmatter helpers enforce required fields without evaluating
source code. `version` is optional and projects as `unversioned` when absent.

## Behavioral invariants

- Missing or invalid frontmatter fails closed.
- Skill roots that are symbolic links are rejected at the trust boundary.
- Agent definition files are read as declarations and never executed.
- Full resources remain unloaded until explicitly requested.
- Installation copies a bounded allowlist of files through a sibling staging directory and atomic rename.
- Installation never follows symbolic links, overwrites an existing Skill, or grants runtime capabilities.
- Workspace updates require an exported ordinary-directory draft plus a fresh digest, and retain recovery state
  when atomic publication cannot be confirmed.

## Failure semantics

Invalid roots, metadata, or definitions produce structured loader errors before content enters context. A load
failure does not fall back to executing or trusting the file.

## Install and minimal use

```sh
npm install @civaapple/qi-skills
```

```ts
import { parseFrontmatter } from "@civaapple/qi-skills";

const parsed = parseFrontmatter(
  "---\nname: explain\ndescription: Explain a repository\n---\nRead the smallest relevant files.",
  "Example Skill",
);
```

## Public API

`SkillLoader`, `SkillCatalog`, skill metadata/result types, agent definition types, and frontmatter parsing helpers.

`SkillCatalog.install()` accepts an explicit local directory or a bare name found under configured compatibility
roots such as `~/.codex/skills` (including `.system/<name>`). It has no implicit network registry. User scope is
the API default; callers must request Workspace scope explicitly.

`exportWorkspaceDraft()` and `updateWorkspace()` are the create-draft/update pair for existing Workspace Skills.
They do not weaken the generic `.qi` file boundary; callers must still provide effect and path authority.

## Change guide

Keep discovery cheap and loading explicit. New metadata fields must define validation and whether they affect
selection, context, or only presentation; none may imply authority.

## Verification

`tests/skills-agent.test.mjs` covers progressive disclosure, scope precedence, bounded local installation,
frontmatter, symlink roots, and non-execution.

## Further reading

- [Loading security](docs/loading-security.md)
- [Skill and extension design](../../design/system-design.md#8-extensions-skills-mcp-codeact-graph-delegation-scheduling-and-introspection)
