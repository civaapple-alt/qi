# Changelog

Notable user-visible, compatibility, security, and packaging changes are recorded here. Internal implementation
steps and investigation history belong in pull requests, not release notes.

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

### Documentation

## [0.5.0] - 2026-07-27

### Added

- MIT licensing and public-package metadata for the CLI and 21 Runtime packages.
- Isolated package consumers, release-candidate auditing, and installable CLI preview checks.
- `@civaapple/qi-agent`, `@civaapple/qi-introspection`, and reusable `@civaapple/qi-tui` package surfaces.
- Tokenless GitHub Actions publishing with npm trusted-publisher provenance.

### Changed

- Renamed the application directory from `apps/tui` to `apps/cli`.
- Changed the installed executable to `qi`.
- Adopted `@civaapple/qi` for the CLI and `@civaapple/qi-*` for Runtime packages.
- Set `civaapple-alt/qi` as the canonical repository.
- Unified product identity, environment variables, local data paths, Session actors, evidence types, and public
  APIs under `Qi`, `QI_*`, `.qi`, and `qi.*`.
- Consolidated public design documentation around the current architecture, decisions, and roadmap.

### Deprecated

### Removed

- Removed the local Jekyll/Docker documentation site and chronological design/process documents from the public
  repository.

### Fixed

- Made CodeAct container staging paths portable across Windows, Linux, and macOS.

### Security

- Expanded ignored-file protection for local credentials, registry configuration, logs, Runtime artifacts,
  packed archives, and editor state.
- Kept the monorepo root private and metadata-only when packed accidentally.

### Documentation

- Replaced iteration-oriented notes with concise contributor-facing architecture and release documentation.
- Restored the foundational product vision around life-like continuity, human-Agent coexistence,
  同行/追寻/守望, and bounded Turn/Goal/Time/Proactive control.
- Added the Contributor Covenant and a private maintainer email as the security disclosure channel.

## [0.4.0] - 2026-07-24

### Added

- Append-only Session events, Kernel projection, SQLite persistence, committed SSE streaming, and crash recovery.
- Provider-neutral model adapters, bounded context compilation, credential handles, and secret redaction.
- Default-deny capability leases, typed Tool phases, precise file mutation, read-only mounts, Effect Journal
  settlement, and bounded ProcessTasks.
- Ask/Plan/Agent modes, durable Questions and Plan review, terminal UI controls, and a read-only Web workbench.
- Goal/evidence evaluation, provenance-backed memory, Skills, MCP quarantine, CodeAct, graph governance,
  depth-1 delegation, and bounded scheduling.
- CLI/package build, replay fixtures, deterministic tests, and live-provider acceptance harnesses.

### Changed

- Completion now distinguishes a model response, a terminal Run, and evidence-backed verification.
- Provisional model/process activity is observable without becoming durable Session truth.
- TUI transcript work is bounded through paint classification, caching, and reversible history folding.

### Security

- Authority grants and Action start facts persist before executor entry.
- Non-read effects use idempotent settlement and are never automatically retried when indeterminate.
- Protected Runtime/VCS paths remain outside ordinary Agent file authority.
