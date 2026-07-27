# Release identity records

This directory contains human-approved, non-secret release identity evidence. Automation reads these records but
does not create them, claim external names, or publish artifacts.

Before public npm publication, maintainers add `registry-identity.json` with:

```json
{
  "registry": "https://registry.npmjs.org",
  "scope": "@civaapple",
  "confirmedBy": "civaapple",
  "confirmedAt": "2026-07-27T00:00:00.000Z",
  "cliPackageName": "@civaapple/qi",
  "packageNamesConfirmed": true,
  "provenance": true
}
```

The record means a maintainer checked scope ownership and package-name availability. It is not a credential and
must contain no npm token. `npm run packages:plan` validates the record, coordinated versions, exact internal
dependency ranges, graph acyclicity, core/extension wave boundaries, and publish metadata. It never calls
`npm publish`.
