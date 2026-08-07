# Contributing

Bug reports and pull requests are welcome. This is a small library with a narrow job, so the bar for
changes is mostly about keeping it small and keeping it correct.

## Running the tests

```sh
npm test              # unit suite — no dependencies, no services
```

There is no test framework and no build step. The suite runs on `node --test` against Node 18+.

## Running against real Redis and MongoDB

The unit suite uses hand-written doubles for Redis and Mongo. Doubles agree with whatever you
believed when you wrote them, so anything touching `src/stores/` must also be run against the real
services:

```sh
docker run -d -p 6379:6379 redis:7
docker run -d -p 27017:27017 mongo:7

npm install --no-save redis ioredis mongodb

REDIS_URL=redis://127.0.0.1:6379 \
MONGO_URL=mongodb://127.0.0.1:27017 \
  npm run test:integration
```

Each backend skips cleanly if its URL is unset, so running this with neither is harmless.

This is not ceremony. The dialect detection in `createRedisStore` originally keyed off
`client.sendCommand`, which the double did not implement — the unit suite passed while real ioredis
received `SET key value [object Object]` and replied `ERR syntax error`. If you make a double more
permissive than the real thing, you have written a test that agrees with your bug.

## What a good pull request looks like

- **A test that fails before the change and passes after.** For a bug fix, the test should describe
  the failure in the language of the problem ("a stale lock is reclaimed"), not the implementation.
- **No new runtime dependencies.** Zero dependencies is a feature — it is why this can be audited in
  an afternoon and why it does not drag a transitive tree into a payments service.
- **Existing style.** No linter is configured; match the surrounding code.
- **Comments that explain why, not what.** The awkward reasoning — why 5xx is not cached, why the
  store key is length-prefixed — is the part worth writing down.

## Changes that need extra care

Anything touching these has a correctness argument attached, so please make the argument in the PR
description:

- `store.create` in any store. Atomicity here is the entire guarantee.
- The lock expiry and reclaim path. Getting it wrong either wedges keys or allows double execution.
- `buildStoreKey`. It is what keeps one tenant out of another tenant's stored responses.
- The `res.write`/`res.end` wrapping. It must never change what the client receives.

## Reporting a security issue

Please do not open a public issue. Use
[GitHub's private advisory form](https://github.com/milonpatowary/express-idempotency/security/advisories/new).

Findings that let one scope read another's stored response, or that allow a guarded handler to run
twice, are the ones to look hardest for.

## Releasing

Releases are published by CI from a tag. Nobody publishes from a laptop, and no npm token needs to
exist on anyone's machine.

```sh
# 1. Update CHANGELOG.md and commit it.
# 2. Bump, which also commits and tags:
npm version patch        # or minor / major
# 3. Push the commit and the tag together:
git push --follow-tags
```

The `Release` workflow then runs the unit suite, runs the integration suite against real Redis and
MongoDB, publishes with `--provenance`, and opens a GitHub Release.

Two guards run before anything is published, because npm versions are immutable and a mistake
cannot be taken back:

- the tag must match `package.json` version — a `v0.2.0` tag on a `0.1.0` package fails the job
- the version must not already exist on npm

**Authentication.** The workflow requests an OIDC token, so with [npm Trusted
Publishing](https://docs.npmjs.com/trusted-publishers) configured for this package no secret is
needed at all. Trusted publishing is configured on the package's npm settings page, which means the
package has to exist first — so **the very first release is the exception**: either publish `0.1.0`
once by hand (`npm login && npm publish --access public`), or set an `NPM_TOKEN` repository secret,
which the workflow uses as a fallback. After that, switch to trusted publishing and delete the
secret.

`npm publish` also runs `prepublishOnly`, so the test suite gates a manual publish too.

The package is `express-idempotency-keys`; the repository is `express-idempotency`. See the note in
the README.
