---
name: improve-qi
description: Inspect Qi's versioned self model, locate the owning package and invariant, and implement one bounded evidence-backed improvement without self-authorization. Use for Qi architecture changes, package extraction, release-readiness work, self-model drift, capability extensions, or requests for Qi to understand and improve its own repository.
---

# Improve Qi

Improve one bounded Qi gap through the ordinary design, authority, effect, and evidence boundaries.

## Workflow

1. Inspect current facts.
   - Query `qi_introspect` for `identity`, `packages`, `invariants`, `gaps`, and `verification` when available.
   - If the Tool is unavailable, read `packages/introspection/src/self-model.ts` and follow its canonical links.
   - Treat reported conflicts as unresolved; do not choose the convenient source.

2. Select one bounded gap.
   - Prefer a gap that blocks open-source release, independent package use, self-model integrity, safety, or
     compatibility.
   - Do not bundle unrelated cleanup or experimental capability work into the same change.

3. Locate ownership before editing.
   - Read `AGENTS.md`, the smallest route in `design/README.md`, and every affected package README.
   - State the invariant or public contract being changed.
   - Update `design/decisions.md` first when behavior crosses package control boundaries or reverses an accepted
     decision.

4. Plan the evidence.
   - Identify the allowed and denied/recovery paths.
   - Choose the narrowest package tests plus any required isolated consumer, replay, crash, or release fixture.
   - Keep release, license, registry ownership, governance, and semantic craft assertions human-owned.

5. Implement through ordinary controls.
   - Use normal Workspace Tools and Capability Leases.
   - Never edit `.git`, `.artifacts`, private Session state, credentials, or protected `.qi` runtime files
     through Agent file tools.
   - Never create a grant, relax a policy, retry an indeterminate effect, or publish merely because introspection
     recommends it.

6. Verify and reconcile.
   - Run the planned deterministic checks.
   - Inspect the resulting diff and Action evidence.
   - Update the owning README, accepted design/ADR, `CHANGELOG.md`, and `QiSelfModel` together when their
     facts changed.
   - Run self-model drift checks after package or ADR changes.

7. Hand off honestly.
   - Distinguish implemented, integration-verified, package-preview, published, and product-validated states.
   - List human decisions and external blockers explicitly.
   - Do not claim semantic success from the Agent's own judgment.

## Hard boundaries

- Do not choose an open-source license for maintainers.
- Do not invent a Git remote, npm scope, package name ownership, security contact, or release destination.
- Do not publish source, packages, or releases without explicit human authorization.
- Do not promote an experimental package to stable without consumer compatibility evidence and maintainer review.
- Do not let self knowledge grant write, execute, publish, spend, background, or delegation authority.
