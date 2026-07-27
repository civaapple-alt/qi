# Contributing to Qi

Qi is an evidence-first Agent Runtime. Contributions are welcome when they preserve its control boundaries
and make the system easier to understand, embed, verify, or operate.

The repository is preparing its first public source release. Package APIs remain experimental until their
READMEs and release notes say otherwise.

## Start with the owning contract

1. Read [`AGENTS.md`](AGENTS.md).
2. Use [`design/README.md`](design/README.md) to select the smallest relevant design path.
3. Read the README in every package you plan to change.
4. Treat `design/decisions.md` and tests as architecture reasoning and executable evidence, respectively.

Before editing, state the owning package and the invariant or public contract being changed. Update
`design/decisions.md` before implementation when a change crosses package control boundaries, changes durable
protocol/recovery meaning, or reverses an accepted decision.

## Development

Requirements:

- Node.js 22.19.0 or later;
- npm;
- Docker with Compose for the documentation build.

```sh
npm ci
npm run typecheck
npm test
npm run packages:check
npm run accept:preview
```

Use narrower tests while iterating, then run the verification appropriate to the change. Public-package work
also runs:

```sh
npm run packages:check
```

Live-provider acceptance is opt-in, consumes quota, and must never run from an untrusted contribution without an
explicit operator decision.

## Package changes

Every public-package proposal needs:

- a clear purpose, non-goals, failure semantics, and public API in its README;
- explicit `exports`, `files`, types, engines, dependency ranges, license, and repository metadata;
- a minimal JavaScript/TypeScript consumer example;
- isolated tarball install, import, typecheck, and meaningful execution evidence;
- a compatibility note and CHANGELOG entry for public API changes.

`@civaapple/qi-agent` is a thin façade. Do not move authority, effect settlement, event truth, or completion policy
into it. Reusable TUI work should expose Qi-specific projections and controls rather than duplicate the
underlying general TUI framework.

## Pull request quality

A change should be small enough to explain and verify. Include:

- the problem and why it belongs in Qi;
- affected invariant/package boundary;
- allowed plus denied/recovery evidence;
- user-visible or compatibility impact;
- commands run and their results;
- remaining gaps or human decisions.

AI assistance is allowed, but the submitting person remains responsible for understanding the change, reviewing
the diff, removing private data, and answering design and failure-semantics questions.

## Important human decisions

Agents and automation do not choose the open-source license, create the canonical repository, claim registry
names, change security policy, or publish a release. Maintainers explicitly approve those actions.
