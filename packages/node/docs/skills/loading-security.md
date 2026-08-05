# Skill and Agent definition loading security

Repository-authored instructions are untrusted data until explicitly selected and bounded by runtime policy.

## Progressive disclosure

1. Discover only directory identity and validated metadata.
2. Select a Skill based on task relevance.
3. Load the complete `SKILL.md` when selected.
4. Load linked resources individually and only as required.

This reduces context pressure and prevents unrelated instructions from becoming ambient policy.

## Filesystem boundary

Skill roots must be concrete directories under the configured discovery scope. Symbolic-link roots are rejected so
a package cannot silently redirect loading to a different trust domain. Referenced paths need the same containment
checks.

## Discovery scopes

Qi discovers two local roots:

1. `<workspace>/.qi/skills`
2. `$QI_HOME/resources/skills`

The active catalog is merged by declared Skill name. A Workspace Skill shadows the same-named user Skill so a
repository can pin task-specific behavior without modifying the user's reusable copy. Discovery exposes only
name, optional version (`unversioned` when absent), description, scope, and root identity.

Qi discovers `<workspace>/.agents/skills` as a read-only active root. Global `~/.agents/skills` is read only through
the entries in `.skill-lock.json`; a human activation record under `$QI_HOME/resources` is required before its
Skill can be loaded. The activation record is bound to the lock entry hash, so lock drift removes activation. Qi
reconciles and deletes stale activation records during catalog refresh; an already-running Run keeps its immutable
loaded context, while later Runs fail closed when the external Skill has been removed.
Project `.qi/skills` takes precedence over project `.agents/skills`, which takes precedence over user
`$QI_HOME/resources/skills`, which takes precedence over an activated global `~/.agents/skills`. `~/.codex/skills`
and `~/.claude/skills` are not scanned by default; an explicit path or configured compatibility root is required.

## Installation boundary

Model-operated installation is local-only. A human may additionally select an immutable Git/GitHub commit or a
digest-pinned HTTPS tar archive. Qi validates the complete ordinary-file tree, copies it into a hidden sibling
staging directory, re-loads metadata, then renames atomically. Links/junctions, special files, path escape, case
collision, Windows-reserved paths, VCS/package/cache payloads, oversized trees, overwrite, redirect, and floating
remote identities fail closed. Archive download and expanded-entry sizes are both bounded.

A user-issued TUI command may install to user or Workspace scope. A model-issued installation is write-authorized,
Effect-Journaled, and restricted to Workspace scope. The model may publish a draft from an ordinary Workspace
directory or install a named Skill from a configured local compatibility root; ordinary file tools still cannot
write `.qi`.

Updating is deliberately separate from create-only installation. The dedicated service first exports an existing
Workspace Skill into a new ordinary Workspace directory and returns an `expectedDigest`. `update-workspace`
accepts only that ordinary draft, revalidates its bounded allowlist and metadata, and compares the current
installed digest immediately before publication. A stale draft fails as `SKILL_STALE`.

Publication uses staging, backup, and a recovery marker beside the target under `.qi/skills`. A confirmed failure
restores the backup. If restoration or publication cannot be confirmed, the Action is `indeterminate`, the
recovery marker is retained, and automatic retry is forbidden. This dedicated, authorized, Effect-Journaled path
is the only model-facing mechanism that may modify `.qi/skills`.

Human immutable installs record commit/SHA-256, subdirectory, license, and a canonical tree digest. Remote content
is never fetched because a model mentioned a Skill. `allowed-tools` and Skill-shipped MCP declarations are
advisory data; neither starts a process, connects a server, imports credentials, nor creates a lease.

`/skill:<name> <task>` activates one complete `SKILL.md` for an ordinary Run and records name, scope, tree digest,
and instruction digest in ContextBlock provenance. Other resources remain individually addressable; binary bytes
become Artifacts instead of being decoded as UTF-8.

The TUI autocompletes active names after `/skill:` and requires the operator to provide a task; selecting a name
does not execute it by itself. `/skills` → **Always-on Skills** surfaces Workspace/user Qi (and workspace
`.agents`) catalog entries that are already active without a toggle; global Agent Skills stay behind the
activation manager. If the Workspace root is the user's home directory, its `.agents/skills` path is
treated as the global Agent root and still requires lock-backed human activation.

Scripts require the separate `skill.run-script` execute path. Only `scripts/**`, argv arrays, Workspace cwd, a
bounded timeout, and startup-frozen interpreter profiles are accepted. Host execution remains a full local-code
trust boundary and settles through the ordinary Action/Effect Journal path; Ask and Plan modes deny it.

Claude-compatible plugin Skills use a separate `plugin_skill` catalog backed by the immutable plugin cache. They
are never merged into native `/skills` names, and a Run snapshots enabled plugin keys before model execution.
`plugin_skill` can list/load/read resources in every read-capable mode; `run-script` remains Execute-authorized.
Extensionless plugin scripts are accepted only with the exact `#!/usr/bin/env bash` shebang. Plugin hooks,
lifecycle commands, visual companion servers, and dependency installers are rejected or explicitly unavailable.

## Declarative Agents

Agent definitions describe identity, commitments, boundaries, and selected resources. The loader never imports or
executes an `agent.ts` file to discover those properties.

## Authority separation

A selected Skill can teach the Agent how to request a tool; it cannot grant the tool, workspace path, credential,
or effect. Capability checks remain mandatory at action time.

`tests/skills-agent.test.mjs` is the executable trust-boundary suite.
