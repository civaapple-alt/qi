# Tool execution contract

A tool call crosses several independent boundaries. Keeping them separate makes denial and recovery explainable.

```text
proposal
  -> catalog identity check
  -> input schema validation
  -> resource/effect inspection
  -> capability decision
  -> durable grant and `action.started`
  -> Effect Journal reservation/start when non-read
  -> executor
  -> output validation or Artifact storage
  -> durable settlement
```

## Tool definition requirements

A definition must provide stable identity, input and output schemas, effect/resource inspection, and an executor.
The registry-issued registration handle prevents an implementation changed after advertisement from executing as
the earlier tool.

## Error mapping

- Bad input for an advertised tool: `ToolInputError`; the Loop records `model.action.rejected` and returns
  structured correction feedback before any Action or authority request exists.
- Missing authority: `AuthorityDeniedError`, no executor entry.
- Replaced advertisement: `StaleToolError`.
- Invalid executor output: `ToolOutputError`.
- Known executor failure: `ToolFailure` or failed settlement.
- Unknown effect settlement: `EffectReplayBlockedError` or indeterminate settlement.

Tool results inform the next model Step; they do not directly mark a Goal complete. Tests span
`tests/tools-capability.test.mjs`, `tests/workspace-safety.test.mjs`, and `tests/turn-loop.test.mjs`.

## Read-only discovery

Use `tree` for a bounded architecture overview, `find` for path/name/type/time/depth discovery, `list` for one
known directory, `read` for one known regular file, and `search` for content. Search defaults to literal matching;
regex and glob behavior must be explicit. Keeping these operations separate prevents guessed filenames,
accidental directory reads, and filename queries from masquerading as content matches.

After `search`, pass its 1-based match line to `read.startLine` and request at most the surrounding lines needed
for the next decision. `maxLines` is capped at 500 and defaults to 200 for a ranged read. Returned content keeps
the file's original line endings; range metadata reports omissions, while `size` and `sha256` always describe
the complete file. Calling `read` without a range remains the compatible full-file path.

The fast path resolves trusted `rg` and `fd` executables outside the Workspace and invokes only schema-derived
argument vectors without a shell. Both retain ignore-file and hidden-file defaults. Portable Node traversal is a
bounded fallback; content globs require `rg`. Results report the engine used and remain capped independently of
the command output.

## Precise editing

Use `edit` after `read` when changing an existing file. The read hash is a mandatory freshness precondition, and
the old fragment must occur exactly once unless `replaceAll` is explicitly requested. Missing, stale, ambiguous,
and no-op edits fail before filesystem mutation. The replacement is staged through a temporary file and renamed,
then returns old/new hashes and a bounded contextual unified diff. The matcher reconciles LF, CRLF, or CR in model
arguments to the existing file's line-ending convention and retains an existing UTF-8 BOM; it does not normalize
indentation, trailing whitespace, Unicode lookalikes, or approximate blocks. Replacement text is literal:
JavaScript replacement tokens such as `$$` and `$&` have no special meaning. Atomic replacement preserves the
permission bits of an existing file so editing a script does not silently remove executability. Use `write` only
for creation or deliberate full replacement. Existing mutation targets must be regular, non-symlink files;
directory replacement and mutation through a symbolic-link alias fail before content changes.

Sensitive Workspace paths (for example `.env`, `*.pem`) may appear in `list` / `tree` / `find` metadata, but
content-exposing tools (`read`, content `search`, `edit`, `write`) fail closed with
`SENSITIVE_PATH_GRANT_REQUIRED` until the operator grants that Workspace-relative path. Grants are project
durable and Session-audited; authorized bodies round-trip as raw text for precise `edit`. See
[ADR 0001](../../../design/decisions.md#adr-0001-gate-sensitive-paths-before-content-reaches-the-model).

After `EDIT_TARGET_NOT_FOUND`, reread the file and retry `edit` with a current unique fragment. A generally
authorized shell process can still change Workspace files, but it is not the preferred fallback for editing:
doing so gives up the dedicated tool's per-file freshness and unique-target assertions. Git-backed shell evidence
keeps such an explicit host effect inspectable; it does not make it equivalent to a precise edit.

Within one Step, the Loop may chain only consecutive same-resource `edit` calls whose proposed digest is the
chain's original or latest successfully settled digest. It re-inspects the effective digest before authority,
records `action.freshness.rebased` when the digest changes, and still rejects missing or ambiguous targets.
`write`, `move`, `remove`, mixed mutation sequences, and unrelated digests keep the
`BATCH_WRITE_CONFLICT` path.

Cross-file patch application remains deferred. A patch may reserve several resources and partially commit before
a later hunk fails, so it needs explicit multi-resource settlement and recovery semantics rather than being
smuggled into one ordinary file Action. See
[ADR 0003](../../../design/decisions.md#adr-0003-use-freshness-checked-precise-file-mutation).

File lifecycle changes use the same freshness discipline. `move` accepts only a regular, non-symlink source and
fails if the destination already exists. `remove` accepts only a regular, non-symlink file and persists its full
previous bytes as an Artifact before unlinking it; the returned Artifact reference is the recovery handle.

Use `git` for repository status, unstaged diff, or staged diff while holding only read authority. Its operation
schema does not accept arbitrary arguments, Git optional locks and external diff drivers are disabled, and the
executable must resolve outside the Workspace. General Git commands remain behind the explicit `shell` execute
capability.

General host execution receives a program name and argument vector rather than a command-line string. It does
not expand shell globs, variables, pipes, or redirection; use discovery Tools for paths and a declared script
profile for a real multiline script instead of embedding a long `node -e` program. Bare names resolve through
PATH outside the Workspace. On Windows, PATHEXT resolution may select a `.cmd`/`.bat` shim such as
`npm.cmd`; Qi invokes it through the trusted system command processor only after rejecting argument shell
metacharacters. Direct executables retain normal argument-vector spawning on every platform. Direct execution
requires the `shell-profile:direct` resource in addition to host-process/workspace resources.

Callers pass the target directory through `workdir` and invoke package managers directly, for example
`command: "npm", args: ["run", "build"]`. Wrapping that operation in `bash -c`, `cmd /c`, or
`PowerShell -Command` adds a second platform-specific parser, can select the wrong subsystem or script shim, and
is not portable. Programs that explicitly discard output use the host null device (`NUL` on Windows,
`/dev/null` on POSIX); an HTTP response does not turn a later write failure into a successful command.
The same direct-vector rule applies to ordinary utilities: `command: "mkdir -p pepsi-3d-2/src"` is invalid
because it combines the executable, flags, and operand. Prefer `write`, which creates the parent directories for
the file being written; host-specific directory utilities are not a portable substitute. Explicit executable
paths are validated as files before spawn. A malformed/unavailable command or a confirmed process-start error
is a deterministic failed settlement, not an indeterminate effect; only failures after effect entry whose
settlement cannot be established remain indeterminate.

Authorized script profiles (`pwsh`, `cmd`, `bash`) are a separate `script` tool. They require matching
`shell-profile:<name>` resources, are probed at runtime startup, and never replace `shell` based on command text.
`pwsh` runs with `-NoLogo -NoProfile -NonInteractive` and receives the script on stdin; `bash` uses
`--noprofile --norc -s`; `cmd` runs a temporary script through the trusted system processor. Profile scripts inherit
a credential-scrubbed environment and terminate process trees on timeout or cancel. Host-process environments
also drop npm's lifecycle-exported `npm_config_allow_scripts`: when Qi itself starts through `npm run qi`, that
ambient value must not become an explicit CLI/environment policy for a nested project-scoped `npm install`.
Nested npm processes continue to read ordinary project, user, and global configuration files.

Before and after a shell process, Qi observes bounded fixed-operation Git status and tracked diff when the
Workspace is a repository. The output records state hashes, whether Git state changed, and final status. The
bounded final tracked diff is included only when those state hashes differ; an unchanged command therefore does
not re-emit a pre-existing Workspace diff as causal output. This is audit evidence, not a claim that every byte
change is attributable to the process.
Timeout and non-zero exit produce `action.failed`; stdout, stderr, exit state, and the Git observation remain in
the structured failure details. Host output that clearly identifies as UTF-16LE is normalized to UTF-8 before
bounded capture so Windows diagnostics remain readable without changing settlement semantics.

While shell, script, or verification is running, an optional activity sink receives the latest bounded stdout/stderr
snapshot after the Registry's redaction boundary. It may drive a fixed-height UI tail, but cannot affect the
Tool result, Effect Journal, Session stream, or retry decision. Terminal structured output remains authoritative.

When a run's stdout or stderr exceeds the inline output limit, the complete stream (bounded independently, up to a
much larger ceiling) is stored as a content-addressed Artifact and referenced from the Tool output as `outputRef`,
so truncation for model-context reasons never discards the underlying evidence. An untruncated run carries no
`outputRef`. The `action.completed` Session event surfaces the same reference as its durable `outputRef`.

## Declared verification

The private `.qi/qi.verify.json` manifest is regular, non-symlink, at most 64 KiB, versioned, and strict
about unknown fields. First startup infers standard `package.json` verification scripts and an available Maven
test lifecycle from `pom.xml`. A generated configuration-reminder manifest is refreshed when a supported check
later becomes inferable. An unrecognized
project gets a deliberately failing configuration-reminder profile; it never gets a synthetic pass. A valid
legacy root manifest is copied into the private location without deleting the original.

On startup, every profile is normalized and frozen with a definition hash. The `verify` input is only a schema enum
of those names; the model cannot supply a command, argument, workdir, timeout, or environment. Its execute
capability is scoped to `verification:<name>:<definition-hash>`, not `host-process:**`. Agent tools reject
`.qi`, `.git`, and `.artifacts` paths so ignored runtime configuration cannot become a persistence channel.

Executables resolve outside the Workspace, output is bounded, and the child receives a small operational
environment instead of ambient provider credentials. Exit code, timeout, truncation, duration, and definition
hash remain explicit evidence. The process still runs repository code as the current OS user and may use the
network, so `--allow-verify` is an explicit host-execution decision rather than a sandbox claim. Manifest edits do
not change an active runtime; restart to load a new definition.

A verification timeout or non-zero exit is a failed Action with bounded process details. Only exit code zero can
produce a completed verification Action.

## Controlled network reading

`fetch` is separate from both Workspace reads and host execution. The TUI registers it only under
`--allow-network`, with `read` authority scoped to `network:http(s)://` resources. Its schema accepts one absolute
URL and an optional bounded character limit; callers cannot supply methods, headers, credentials, request bodies,
ports, timeouts, or redirect policy.

Before each connection, the target host resolves to addresses that must all be public. The chosen address is
pinned into the HTTP/TLS connection so a second DNS answer cannot redirect the executor into a private network.
Every redirect repeats validation, HTTPS cannot downgrade to HTTP, and redirect count, duration, raw bytes, output
characters, content types, and encodings are hard-bounded. The output reports the raw response SHA-256 and labels
extracted text as untrusted; fetched page content cannot grant authority or override runtime instructions.

Tests in `tests/network-fetch.test.mjs` cover default denial, permitted public retrieval, literal/DNS private
targets, private redirects, credentials, ports, binary media, response limits, extraction, evidence, and
truncation. `tests/tui-network.test.mjs` proves the tool is absent unless explicitly enabled.
