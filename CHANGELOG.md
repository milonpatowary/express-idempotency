# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — unreleased

Initial release.

### Added

- `idempotency()` middleware for Express 4 and 5, and anything else taking `(req, res, next)`.
- Atomic key claiming, so concurrent retries cannot both execute the handler. Exactly one request
  wins the key; the rest receive `409` with `Retry-After`.
- Request fingerprinting over method, path and a canonical body serialisation. Reusing a key with a
  different payload returns `422` rather than replaying a response that describes a different
  operation. Object key order does not affect the fingerprint; headers are excluded.
- `scope` option for tenant and user isolation. Scope and key are length-prefixed before hashing so
  a crafted key cannot cross a scope boundary.
- Response capture and replay, including status, headers and binary bodies, with `Idempotent-Replay`
  on replayed responses. Framing and hop-by-hop headers are recomputed rather than replayed.
- Self-expiring locks, so a process that dies mid-request does not wedge a key. Aborted requests
  release their key immediately rather than waiting for the lock TTL.
- `5xx` and `429` responses are not stored, so a transient failure does not poison a key for the
  duration of its TTL.
- Responses over `maxBodyBytes` (default 1 MiB) are sent to the client but not stored.
- Stores: in-process memory (default, single process only), Redis (`redis` v4+ and `ioredis`), and
  MongoDB. Custom stores need three async methods.
- `onStoreError` with a `fail-closed` default — a store outage returns `503` rather than silently
  disabling duplicate protection. `fail-open` is available as an explicit opt-in.
- Optional `idempotencyErrorHandler()`; every error also carries `.status` and `.code` for use with
  an existing handler.
- TypeScript definitions, including an `Express.Request.idempotency` augmentation.
- Zero runtime dependencies.

[Unreleased]: https://github.com/milonpatowary/express-idempotency/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/milonpatowary/express-idempotency/releases/tag/v0.1.0
