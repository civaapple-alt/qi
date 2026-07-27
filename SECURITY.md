# Security policy

Qi executes model-directed actions against local Workspaces, so authority, credential, effect, and recovery
failures are security issues even when they do not resemble a conventional network vulnerability.

## Supported versions

Before the first public source release, only the current mainline and the latest tagged preview receive security
fixes. The supported-version table will become release-specific when the canonical public repository exists.

## Reporting

Do not disclose a suspected vulnerability, credential, private Session database, or exploit trace in a public
issue.

Use the canonical repository host's private vulnerability-reporting channel after maintainers enable and link it
from the public repository. If that channel is not present, contact a listed maintainer through a previously
verified private channel and request reporting instructions before sending sensitive material.

The absence of a configured private reporting destination is an open-source release blocker, not permission to
post sensitive details publicly.

## Include

Provide the smallest safe reproduction and describe:

- affected version/commit and platform;
- required capability grants and Session mode;
- whether a Tool executor was entered;
- durable event and Effect Journal settlement;
- whether credentials, private files, or external effects were exposed;
- restart/replay behavior;
- suggested mitigation if known.

Redact secrets and private repository content. Content hashes, event types, error codes, and a synthetic fixture
are preferred to raw private data.

## Security boundaries

Qi treats the following as release-critical:

- authority and `ActionStarted` before executor entry;
- default-deny and non-widening delegation;
- non-read Effect Journal settlement;
- no automatic retry of indeterminate effects;
- secret redaction and opaque credential handles;
- protected `.qi`, `.git`, and `.artifacts` paths;
- Skill/MCP/introspection knowledge never granting authority;
- human approval for publication and security-policy changes.
