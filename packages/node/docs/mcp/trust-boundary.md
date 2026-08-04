# MCP trust boundary

MCP expands discoverable integrations, not ambient authority. Qi uses quarantine and explicit binding to
prevent remote metadata from becoming an executable local capability.

## Stages

```text
inert reviewed declaration
-> explicit human refresh/connect
-> quarantined fingerprinted candidate
-> human/policy-reviewed binding
-> local Tool Registry advertisement
-> per-call validation and authorization
-> remote invocation
-> bounded result or Artifact
```

The binding fixes server and remote kind/name, normalized metadata fingerprint, effect class, and resource mapping.
Every Run freezes declarations and bindings. Reconnect or `list_changed` compares a fresh fingerprint; missing or
changed entries become `drifted`, and new calls fail until a human rebinds. An in-flight Action keeps its original
snapshot only to reach an honest settlement.

stdio permits explicitly declared `npx` and `uvx` launchers for registry-published MCP servers, rejects other
package-manager and shell wrappers, and runs the resolved launcher under a minimal environment. The launcher
path/hash and full declared argv are fingerprinted as transport identity. Exact package versions are recommended;
a floating selector such as `@latest` or an unpinned uvx package remains an explicit reproducibility risk because
it may resolve to new code without changing the declaration.
HTTP requires HTTPS except loopback, refuses URL credentials and redirects, and requires explicit declaration for
private/LAN targets. legacy SSE is never an automatic fallback. Static credentials and OAuth state/tokens live in
the encrypted Credential Store; config and events carry aliases only. OAuth uses SDK discovery, PKCE S256,
explicit state validation, resource-origin validation, refresh rotation, and denies silent scope step-up.

## Result handling

Remote output is untrusted tool output. It is schema-checked, size-bounded, and may be stored as an Artifact.
Content returned by the remote server cannot create another binding or lease by instruction.

## Failure handling

Dispatch-independent validation and authorization failures are deterministic. Remote `isError` and invalid output
schema are known Tool failures. A non-read disconnect after dispatch is conservatively `indeterminate` and never
auto-retried; read Resource/Prompt requests may reconnect once. Remote text is labeled untrusted, binary content
becomes an Artifact, and Resource Links are not followed automatically.

See `tests/mcp-bridge.test.mjs`.
