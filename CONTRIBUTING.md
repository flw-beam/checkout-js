# Contributing

Thank you for helping. Issues are the best way in: a bug, a confusing error, a
gap in a README, or something the SDK makes harder than it should be.

## Pull requests

This repository is published from Flutterwave's internal repository, where the
code is developed against the checkout service and its API contract. Every sync
replaces every file here, so a pull request cannot be merged as it stands.

A pull request is still useful, because it shows exactly what you mean. A
maintainer makes the change upstream and closes your pull request with a link to
the sync that carries it.

Two kinds of change are always made upstream first, however small:

- the API's types under `packages/contracts-ts/src/gen`, which are generated from
  the API contract;
- anything that changes what is sent to the checkout API, which has to agree with
  the service that receives it.

## Building and testing

You need Node.js 20 or later and pnpm, through Corepack:

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

`node scripts/verify-install.mjs --local` packs every package the way a release
does and installs the tarballs into an empty project with npm and with pnpm,
which is the check to run if you change how a package is built or what it
depends on.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never
in an issue or a pull request.
