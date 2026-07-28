# Roadmap

Qi 0.6 has a working local Runtime, a six-package public graph, generationed private storage, declaration-only
package installation, deterministic tests, and local package installation evidence. The roadmap now focuses on
making those surfaces honestly usable by external contributors and consumers.

This is not an implementation diary. Completed details belong in the changelog; current architecture belongs in
[system-design.md](system-design.md), and the product north star belongs in
[product-vision.md](product-vision.md).

## Maturity terms

- **Implemented**: the behavior exists and has focused deterministic tests.
- **Integration verified**: the behavior passes its owning package and cross-package path.
- **Package preview**: a tarball installs and works in an isolated JavaScript/TypeScript consumer.
- **Published experimental**: a registry consumer can install it, but compatibility may still evolve.
- **Stable**: compatibility, migration, support, and release policy are explicit.
- **Product validated**: representative non-author users have demonstrated the intended outcome.

These terms are independent. Passing tests does not prove product value; publishing a package does not make it
stable.

## Current release gates

### Source repository

- MIT license and repository metadata are present.
- Candidate scans must exclude credentials, Runtime state, generated output, and packed artifacts.
- `CONTRIBUTING.md`, `SECURITY.md`, and governance/conduct policy must identify real maintainer-owned channels.
- The candidate must be based on a clean Git commit.

### npm packages

- The coordinated `qi-protocol`, `qi-ai`, `qi-agent`, `qi-node`, `qi-tui`, and `qi` CLI packages must pass
  manifest, dependency-graph, tarball, and isolated consumer checks.
- Public exports must be intentional and documented.
- Registry identity and provenance configuration must be rechecked immediately before publication.
- Publication always requires an explicit maintainer action; readiness scripts never publish.

### Runtime

- `npm run typecheck`
- `npm test`
- `npm run packages:check`
- `npm run accept:preview`
- `npm run release:audit`

Live-provider acceptance is opt-in because it consumes credentials and quota.

## Near term

1. Publish the source repository after security and conduct contacts are approved.
2. Install the CLI preview on Windows, macOS, and Linux through CI.
3. Publish the coordinated npm package graph in dependency order.
4. Re-run consumers against the registry rather than local tarballs.
5. Mark packages experimental until compatibility and migration commitments are reviewed.

## Product validation

After the source and packages are available externally:

- test whether continuity, real state rhythms, remembered shared experience, and unfinished Goals create
  life-like presence without persona decoration or anthropomorphic deception;
- validate the 同行 / 追寻 / 守望 entrypoints with real Turn, Goal, and watcher evidence rather than cosmetic
  mode labels;
- observe real coding and long-running local workflows;
- measure recovery from denied, cancelled, crashed, and indeterminate Actions;
- compare single-Agent work with opt-in delegation under equal budgets;
- test whether evidence views help users make better continuation and approval decisions;
- test whether users can understand and control the same Session world across CLI and the read-only Web surface;
- measure proactive relevance, timing, actionability, quiet-time compliance, and unwanted-interruption rate;
- collect concrete requests before adding a daemon, writable Web surface, recursive delegation, or autonomous
  background behavior.

## Explicitly deferred

- writable Web/remote control plane;
- recursive or default-on Multi-Agent execution;
- automatic package publication;
- automatic retry of indeterminate effects;
- self-authorized policy, security, governance, or release changes;
- compatibility claims unsupported by old-history and isolated-consumer evidence.
