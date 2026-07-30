# `@civaapple/qi-node/tools`

Typed tool definitions and a staged registry that separates discovery from authorized execution.

## Purpose

The Tool Registry validates advertised identity and schemas, asks the capability boundary for authority, enters
the executor only after durable lifecycle events, validates output, and settles effects through Workspace ports.

## Non-goals

- Registering or discovering a tool does not authorize it.
- Tool success does not prove Goal completion.
- Tool implementations do not own Session lifecycle transitions.

## Core model

`defineTool()` creates typed definitions. Registry inspection produces an `InspectedToolCall`; authorization
produces an `AuthorizedToolCall`; execution returns a `ToolSettlement`. Registration handles prevent a changed
tool implementation from impersonating a previously advertised identity.

Built-ins provide bounded directory listing and tree rendering, fd-accelerated file discovery, rg-accelerated
content search, whole-file or bounded line-range reads, file write/edit, fixed read-only Git inspection,
controlled public HTTP(S) text retrieval,
argument-vector `shell` (`shell-profile:direct`), explicit `script` profiles (`pwsh`/`cmd`/`bash`), and
content-addressed artifact storage. `tree`, `find`, `list`, `read`, `search`, `git`, and `fetch` remain separate so
local discovery, repository inspection, external evidence, and execution authority are explicit.

Existing files have a dedicated `edit` operation: the caller supplies the hash returned by `read`, one exact old
fragment, and its replacement. LF/CRLF differences in model arguments are reconciled to the file's convention;
other whitespace remains exact, and an existing UTF-8 BOM is retained. A non-unique fragment is rejected unless
`replaceAll` is explicit. `write` remains the operation for new files or intentional full replacement. Both
return bounded contextual unified diffs rather than representing every unchanged line as replaced. `move` and
`remove` also require the current content hash; moves refuse destination overwrite, while removals store the
complete previous bytes as an Artifact first.

`prepareVerificationProfiles()` creates or migrates the private `.qi/qi.verify.json` manifest;
`loadVerificationProfiles()` validates it and freezes normalized definitions. `createVerifyTool()` exposes only
the declared profile-name enum; commands, arguments, working directories, and timeouts never come from model
input. Each capability resource includes the profile name and definition hash.

`scanVerificationCandidates()` separately *proposes* verification profiles for a human to review: it reads
`package.json` scripts, a `pom.xml` presence, and fenced code blocks under headings in `AGENTS.md`/`README.md`,
filters out shell-metacharacter and known long-running (`start`/`dev`/`serve`/`watch`) commands, and marks each
candidate `recommended` (manifest/package-inferred) or not (doc-scanned) and `available` based on
`findTrustedExecutable()`. It writes nothing. `writeVerificationManifest()` takes the human-selected subset and
writes `.qi/qi.verify.json` through the same atomic write and `loadVerificationProfiles()` validation as the
automatic inference path, so a hand-picked manifest is exactly as trustworthy as an inferred one.

## Behavioral invariants

- Input validation precedes authorization and execution.
- A denied call never enters its executor.
- Advertised tool identity must still match at execution time.
- Recursive access requires explicit tree authority.
- Directory discovery is bounded, deterministic, and excludes generated/runtime trees.
- Search matches file contents via literal mode by default or explicit regex mode; it is not filename discovery.
- Read accepts an optional 1-based `startLine` and at most 500 lines. Partial content preserves source line
  endings while size and SHA-256 continue to describe the whole file.
- Find filters paths by pattern, type, modification time, and depth. Matching defaults to literal substring;
  patterns that look like globs (`*`, `?`, `[]`, `{}`) use glob mode; regex is explicit. Tree renders a bounded
  architecture view.
- Trusted `rg` and `fd` executables must resolve outside the Workspace; portable fallbacks retain core behavior.
  Trusted-executable PATH resolution is cached per command/Workspace root/PATH triple for the process lifetime,
  and `prewarmTrustedExecutables()` primes common candidates for the detected language stack at startup so the
  first `search`/`find`/`shell`/`script`/`verify` call does not pay PATH-walk latency.
- Edit requires a fresh file hash, treats replacement text literally, reconciles only line-ending representation,
  and rejects missing, ambiguous, stale, or no-op replacements before mutation.
- Atomic replacement of an existing file preserves its Unix permission bits, including executability.
- Write and edit reject existing directories and symbolic links rather than following an alias to another target.
- Agent-facing paths cannot enter `.qi`, `.git`, or `.artifacts`, including through an in-Workspace symlink.
- Move and remove require a fresh regular-file hash; move never overwrites, and remove returns a recovery Artifact.
- Git inspection accepts only status, unstaged diff, or staged diff and resolves Git outside the Workspace.
- Verification accepts only frozen profile names, resolves executables outside the Workspace, and strips ambient
  provider credentials from the child environment.
- Network fetch is absent by default, uses credential-free GET only, pins validated public DNS results through
  connection, and revalidates every bounded redirect. Local/private targets and binary or oversized output fail
  closed; returned page text remains explicitly untrusted.
- Shell arguments are not interpolated through an ambient shell and globs, pipes, and redirection are not
  expanded. Windows PATH/PATHEXT shims are resolved explicitly; `.cmd`/`.bat` invocation rejects shell
  metacharacters before entering the trusted command processor.
- Shell and declared verification timeouts or non-zero exits are failed Actions, not successful settlements with
  an error-shaped payload. Failure details retain bounded process evidence for the next Step.
- In Git Workspaces, shell execution records before/after state hashes and a bounded tracked diff when that
  command changed Git state; an unchanged command does not repeat a pre-existing diff as its own mutation.
- Tool output may still pass through narrow literal redaction (provider tokens, PEM blocks, Bearer values, URL
  userinfo) before Effect Journal completion, model feedback, and Session settlement. Source-code assignment
  forms are not rewritten; sensitive Workspace paths are gated by human content grants instead.
- Optional process activity callbacks receive only redacted bounded snapshots; they are provisional observation,
  not Tool settlement or durable evidence.
- Oversized or complete outputs can be stored as Artifacts instead of flooding context. `shell`, `verify`, and
  `script` store the complete stdout/stderr (bounded independently of the inline output limit) as an Artifact
  and return an `outputRef` whenever a run's inline output was truncated, so nothing is silently discarded.
- `scanVerificationCandidates()` only proposes; it never writes a manifest, and an unresolvable executable is
  marked unavailable rather than silently omitted, so a caller can present it as visibly disabled.
- `writeVerificationManifest()` rejects an empty selection, an invalid or duplicate profile name, before writing;
  it validates the written manifest through the same `loadVerificationProfiles()` path used everywhere else.

## Failure semantics

Input, output, authority denial, stale registration, executor failure, and indeterminate effect replay use
separate error or settlement types.

## Install and minimal use

```sh
npm install @civaapple/qi-node/tools @civaapple/qi-agent/capability
```

```ts
import { InMemoryCapabilityBroker } from "@civaapple/qi-agent/capability";
import { ToolRegistry } from "@civaapple/qi-node/tools";

const registry = new ToolRegistry(new InMemoryCapabilityBroker());
// Registering a Tool only makes it discoverable; execution remains default-deny.
```

## Public API

`defineTool()`, `ToolRegistry`, tool phase types, built-in tools, verification profile preparation/loading,
verification candidate scanning (`scanVerificationCandidates()`, `writeVerificationManifest()`), artifact
storage, controlled network fetch, and structured tool errors.

## Change guide

For a new tool, define resource extraction and effect class before the executor. Add allowed, denied, stale,
invalid, and effect-recovery tests where relevant.

## Verification

Use `tests/tools-capability.test.mjs`, `tests/network-fetch.test.mjs`, `tests/workspace-safety.test.mjs`,
`tests/turn-loop.test.mjs`, and `tests/verify-scan.test.mjs`.

## Further reading

- [Execution contract](docs/execution-contract.md)
- [Effect Journal](../workspace/docs/effect-journal.md)
- [Tool and effect design](../../design/system-design.md#4-workspace-authority-and-effects)
