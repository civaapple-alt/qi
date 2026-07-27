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
2. `~/.qi/skills`

The active catalog is merged by declared Skill name. A Workspace Skill shadows the same-named user Skill so a
repository can pin task-specific behavior without modifying the user's reusable copy. Discovery exposes only
name, optional version (`unversioned` when absent), description, scope, and root identity.

## Installation boundary

Installation is local-only. A source is either an explicit directory or a bare name resolved from configured
compatibility roots such as `~/.codex/skills/.system`. Qi validates the source, copies `SKILL.md`, recognized
resource directories, Agent metadata, and root license/notice files into a hidden sibling staging directory, then
renames it atomically. It rejects symlinks, oversize files/packages, destination overwrite, and cache artifacts.

A user-issued TUI command may install to user or Workspace scope. A model-issued installation is write-authorized,
Effect-Journaled, and restricted to Workspace scope. The model may publish a draft from an ordinary Workspace
directory or install a named Skill from a configured local compatibility root; ordinary file tools still cannot
write `.qi`.

## Declarative Agents

Agent definitions describe identity, commitments, boundaries, and selected resources. The loader never imports or
executes an `agent.ts` file to discover those properties.

## Authority separation

A selected Skill can teach the Agent how to request a tool; it cannot grant the tool, workspace path, credential,
or effect. Capability checks remain mandatory at action time.

`tests/skills-agent.test.mjs` is the executable trust-boundary suite.
