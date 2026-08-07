# Workspace isolation

Workspace isolation limits what the executor can reach. Capability authorization independently decides what the
subject is allowed to do. Both are required.

## Local workspace

Paths are resolved lexically under a configured root. Reads return freshness observations that callers can check
before mutation. `LocalWorkspace` rejects `..` traversal outside the root but follows filesystem links during
observation; the built-in Agent file tools add realpath containment and symbolic-link rejection. Do not use the
low-level adapter alone as a symlink-safe sandbox.

## Container workspace

`ContainerWorkspaceAdapter` bind-mounts the configured Workspace, disables network by default, and uses a
read-only container root. The Workspace mount is read-only unless `writableWorkspace` is explicitly requested;
the adapter does not stage a selected-file subset or create a separate output mount. Runtime unavailability is an
honest failure, not permission to fall back to host execution.

## Git worktree workspace

A worktree gives delegated or isolated work a separate branch and filesystem view. Its diff is evidence that can
be inspected before integration; worktree creation itself grants no merge or publish authority.

## Adapter checklist

Document root, mounts, network, process identity, credentials, cleanup, time/resource limits, observation model,
and crash behavior. Test the escape path and unavailable-runtime path, not only successful execution.

Host process helpers scrub credential-like environment names by default and terminate process trees on timeout or
cancel so Agent-executed commands do not inherit Provider secrets or leave orphaned children. After graceful
termination, helpers escalate to a forced kill and still settle the host-process Promise if exit/`close` cannot
be confirmed, so finite Tools cannot hang forever waiting on a non-exiting child.

Agent **shell / script / verify / skill-script / MCP stdio** children are optionally composed through
`@civaapple/qi-node/sandbox` ([ADR-0041](../../../design/decisions.md#adr-0041-graded-process-sandbox-srt--windows-low-il--host)):
srt when available, Windows Low IL as a reduced middle tier, otherwise host with honest disclosure. That OS layer
is dual to Workspace path guards—not a replacement for them.
