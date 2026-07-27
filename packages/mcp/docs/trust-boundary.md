# MCP trust boundary

MCP expands discoverable integrations, not ambient authority. Qi uses quarantine and explicit binding to
prevent remote metadata from becoming an executable local capability.

## Stages

```text
remote list
-> quarantined candidate
-> human/policy-reviewed binding
-> local Tool Registry advertisement
-> per-call validation and authorization
-> remote invocation
-> bounded result or Artifact
```

The binding fixes local name, the most recently discovered schema/description, effect class, resource mapping,
output budget, and the configured transport instance. The current bridge does not attest a remote server version
or detect behavior drift behind the same remote name; deployments must rediscover/review/rebind on server change
and treat remote output as untrusted even when its local binding is unchanged.

## Result handling

Remote output is untrusted tool output. It is schema-checked, size-bounded, and may be stored as an Artifact.
Content returned by the remote server cannot create another binding or lease by instruction.

## Failure handling

Transport errors, remote tool errors, schema drift, authority denial, and output overflow are separate observable
outcomes. Reconnect or rediscovery does not imply automatic reauthorization.

See `tests/mcp-bridge.test.mjs`.
