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

Opaque handles cannot protect a password that already exists in a Workspace file. Qi therefore:

1. Classifies high-risk paths (for example `.env`, `*.pem`) before content-exposing tools execute.
2. Lets discovery tools (`list` / `tree` / `find`) show those paths as metadata, optionally marked `sensitive`.
3. Requires an explicit human grant before any file body from those paths enters tool settlement or model
   feedback (`SENSITIVE_PATH_GRANT_REQUIRED`). Grants persist in project config and Session audit facts.
4. Returns authorized file bodies as raw text so precise `edit` can round-trip.

Last-resort content redaction remains only for extremely high-confidence literals (provider API tokens, PEM
private-key blocks, URL userinfo, Bearer authorization values). It must not rewrite source-code assignment
forms such as `password: &str`, and it is not a substitute for path grants.

Existing Session databases are not retroactively rewritten; exposure response still requires rotating the
credential and deciding whether to retain the affected database.

`tests/workspace-safety.test.mjs` covers subject- and intent-bound resolution. `tests/safety-redaction.test.mjs`
covers sensitive-path gating, source round-trip, and narrow literal redaction.
