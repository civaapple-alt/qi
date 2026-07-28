# Credential handles

Credentials remain behind a broker and are referenced through opaque, subject- and intent-bound handles.

## Threat model

Raw secrets placed in prompts, Session events, tool catalogs, logs, or Artifacts can be replayed or exposed to an
unrelated action. A capability lease alone does not make those copies safe.

## Contract

- A handle names a broker-held secret without containing it.
- Resolution checks the current subject and intent.
- Callers receive the minimum runtime material needed at the final adapter boundary.
- The handle and secret lifetime may be shorter than the Session.
- Handles are not transferable to a delegated child unless explicitly reissued under narrowed scope.

## Logging and persistence

Log handle identity and policy decision when useful, never resolved secret material. Session events may record
that credential-backed authority was used without serializing the credential.

## Repository-discovered secrets

Opaque handles cannot protect a password that already exists in a file the Agent is authorized to read. Qi
therefore applies the same high-confidence redactor to Tool output, provider-bound portable messages, model
output, and EventWriter payloads. The replacement preserves surrounding structure while
`safety.redaction.applied` records only the boundary, category, and count.

This guard is intentionally narrower than general sensitive-data classification. Existing Session databases are
not retroactively rewritten; exposure response still requires rotating the credential and deciding whether to
retain the affected database.

`tests/workspace-safety.test.mjs` covers subject- and intent-bound resolution. `tests/safety-redaction.test.mjs`
covers model-boundary and durable-event redaction.
