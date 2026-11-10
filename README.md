# entity-api

Make an entity store reachable by name, so a remote caller can rely on exactly what a local one can.

**Status: built, and certified at zorg's Delta 1, stage 5 (`185c590`), Delta 4, stage 2 (`1920997`), and Delta 4, stage 7 (`d5b0879`).**\
Its contract tests run entity-store's shared contract suite against a store called directly and against the same store served by the host half and called through the client half, and test each of its own rows, over AGP's production in-process carrier with AGP's injected clock and a separate clock for each call's bound.

- `VISION.md` - why it exists, and what it will never be.
- `CONTRACT.md` - what a consumer can depend on, one capability per row.
- `docs/DECISIONS.md` - the rulings about this component.

It belongs to a component set first composed by zorg (`apnex/zorg`), and is released only by its own CI, as a tarball attached to a GitHub release with its SHA-512 beside it, which a consumer names in its `package.json`: `https://github.com/apnex/entity-api/releases/download/v0.1.0/apnex-entity-api-0.1.0.tgz` for `0.1.0`.

It depends on `@apnex/entity-store`, `@apnex/operation-call` and `@apnex/shape-check` through their release files, and takes AGP's types only, from `@agp/node`, `@agp/core` and `@agp/transport-loopback` in its development dependencies, `file:` links to an AGP checkout beside it.\
Each such link installs none of its package's own dependencies, so each checkout must be installed and built first, since no `dist/` is committed.

To run the tests from clean checkouts:
```sh
(cd ../agp && npm install && npm run build)
(cd ../shape-check && npm install && npm run build)
(cd ../entity-store && npm install && npm run build)
(cd ../operation-call && npm install && npm run build)
npm install
npm test
```
