# aube-primer-packages

Ranked npm package-name inputs for aube's bundled resolver primer.

The generated files live in `data/`:

- `packages.json`: JSON array of the top 2,000 package names.
- `packages.txt`: newline-delimited package names for quick inspection.
- `packages.sha256`: SHA-256 checksum for `packages.json`.

The list refreshes monthly via GitHub Actions from the npm-rank package
ranking artifact, then normalizes the result into the stable source that aube
consumes when regenerating its primer.
