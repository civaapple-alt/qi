# Qi governance

Qi currently has a small maintainer group of two or three active participants. Governance optimizes for
clear responsibility, reversible decisions, and a review load the maintainers can actually sustain.

## Decision ownership

- Accepted design and ADRs own cross-package architecture.
- Package maintainers own package contracts and compatibility within those decisions.
- Runtime schemas and tests provide machine-readable and executable evidence.
- Maintainers retain final responsibility for license, security, governance, registry, and release decisions.

Material reversals update the current decision record with compatibility and evidence requirements. Product
claims use the maturity terms defined in [`design/roadmap.md`](design/roadmap.md).

## Review

At least one maintainer other than the author should review security, protocol, public API, migration, release,
and governance changes when team availability permits. When only one maintainer is available, the change remains
unreleased or explicitly marked preview until independent review occurs.

Automation and Agents may prepare changes and evidence. They do not approve their own semantic success or perform
Important publication actions without a maintainer.

## Package maturity

Public source does not make every package stable. Package READMEs and the `QiSelfModel` distinguish internal,
packable preview, published experimental, and published stable states. Promotion requires isolated consumer
evidence and maintainer approval.

## Community conduct

Participation requires respectful, technical, good-faith collaboration. Harassment, threats, disclosure of
private information, and knowingly unsafe contribution practices are not accepted. The
[Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) defines the community standard, enforcement process,
and private moderation contact.
