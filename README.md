# express-idempotency-keys

**Stripe-style idempotency keys for Express.** Safe retries for `POST`, `PATCH`, `PUT` and
`DELETE` — correct when two copies of the same request arrive at the same moment, not just when
they arrive one after the other.

[![CI](https://github.com/milonpatowary/express-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/milonpatowary/express-idempotency/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/express-idempotency-keys.svg)](https://www.npmjs.com/package/express-idempotency-keys)
[![license](https://img.shields.io/npm/l/express-idempotency-keys.svg)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

```js
app.use(express.json())
app.use(idempotency({ store }))
```

That is the whole integration. Your handlers do not change.

---

## The problem

A client sends `POST /charges`. The response is slow, so their HTTP library times out at 10s and
retries. Your handler had already committed the charge — it just hadn't finished writing the
response. The customer is now charged twice.

Retries are not the anomaly here. They are the correct behaviour of every HTTP client, load
balancer and mobile network on earth. Your API is the thing that has to cope.

The fix is an idempotency key: the client generates a unique id per logical operation and sends it
with every attempt. The server runs the operation once, remembers the response, and hands back the
same response for every retry of that key.

Getting that right is more subtle than a cache lookup, which is what this library is for.

---

## Install

```sh
npm install express-idempotency-keys
```

Zero runtime dependencies. Node 18+. Works with Express 4 and 5, and with anything else that
speaks `(req, res, next)`.

> **On the name.** The package is `express-idempotency-keys`; the repository is
> `express-idempotency`. The shorter npm name belongs to
> [an unrelated package](https://www.npmjs.com/package/express-idempotency) by the City of
> Montreal, which solves a similar problem with a different design. This is not a fork of it and
> shares no code with it.

---

## Quick start

```js
const express = require('express')
const { idempotency, idempotencyErrorHandler, createRedisStore } = require('express-idempotency-keys')

const app = express()

// Body parsing must come first — the fingerprint is computed from req.body.
app.use(express.json())

app.use(
  idempotency({
    store: createRedisStore({ client: redis }),

    // Two different users must never share a key. Return a stable id.
    scope: (req) => req.user.tenantId
  })
)

app.post('/charges', async (req, res) => {
  const charge = await billing.charge(req.body) // runs at most once per key
  res.status(201).json(charge)
})

app.use(idempotencyErrorHandler()) // optional
```

The client sends a key with every attempt:

```
POST /charges
Idempotency-Key: 4f8a1c2e-9b3d-4a7e-8c1f-2d5e6a7b8c9d
```

---

## What happens, precisely

| Situation | Result |
|---|---|
| First request with a key | Handler runs. Response is sent and stored. |
| Retry, same key, same payload, original finished | Stored response replayed. Handler does **not** run. `Idempotent-Replay: true`. |
| Retry, same key, same payload, original **still running** | `409` + `Retry-After`. Handler does **not** run. |
| Same key, **different** payload | `422`. Handler does not run. |
| Same key, different tenant (via `scope`) | Treated as a different key entirely. |
| No key sent | Passes straight through, unless `requireKey` is set. |
| `GET` / `HEAD` / safe methods | Ignored — they are already idempotent. |
| Handler returned `5xx` or `429` | **Not** stored. The next attempt genuinely retries. |
| Handler returned `4xx` | Stored. The client caused it, and it is deterministic. |
| Client disconnected mid-request | Key released. The next attempt runs the handler. |
| Handler hung and never responded | Key released after `lockTtlMs` (default 60s). |
| Store unreachable | `503` by default. See [failure modes](#when-the-store-is-down). |

---

## The parts that are easy to get wrong

Most of this library is the handling of the awkward cases. They are worth knowing about even if you
end up writing your own.

### Concurrent retries, not just sequential ones

A naive implementation reads the key, sees nothing, and runs the handler. Two simultaneous requests
both read nothing, and both run the handler. The window is small and it is hit constantly in
production, because retries cluster — a load balancer timeout and a client timeout tend to fire at
nearly the same moment.

Every store here claims the key with a single atomic operation (`SET NX PX` in Redis, a
duplicate-key insert in Mongo) *before* the handler runs. Exactly one request can win. Everyone else
is told the operation is in flight and asked to retry.

### Same key, different body

If a client reuses a key for a genuinely different operation, replaying the first response would
quietly tell them their second, different request had succeeded. This library fingerprints the
method, path and body, and returns `422` when they disagree.

The fingerprint is computed over a canonical serialisation, so `{a: 1, b: 2}` and `{b: 2, a: 1}` are
the same request — an honest retry that happens to serialise its JSON differently is not punished.
Headers are excluded, so refreshing an auth token between attempts is fine too.

### Tenant isolation

`scope` is the most important option here and it defaults to empty, which is deliberate — silently
sharing keys across users would be worse than making you choose. In a multi-tenant system, set it:

```js
idempotency({ scope: (req) => req.user.tenantId })
```

The scope and key are length-prefixed before hashing, not just joined with a separator. Joining on a
delimiter alone is forgeable: scope `a` with key `b\nc` and scope `a\nb` with key `c` flatten to the
same string, which is enough to read another tenant's stored response if you pick your key carefully.

### Not caching failures

A `500` usually means something transient broke. Storing it would turn a momentary blip into a
permanently poisoned key — every retry for the next 24 hours would replay the failure instead of
attempting the work. `5xx` and `429` are therefore not stored, and the key is released so the next
attempt is a real one.

Client errors *are* stored: a `422` for insufficient funds is deterministic, and re-running the
handler to produce it again is waste.

### Locks that clean up after themselves

If the process holding a key dies mid-request, that key must not stay locked forever. Rather than a
background reaper, the in-progress record carries its own expiry, enforced by Redis' `PX`, Mongo's
TTL index, and an explicit timestamp check in application code (Mongo's TTL monitor only sweeps
about once a minute, so the index is for reclaiming disk, not for correctness).

An aborted request releases its key immediately via the response `close` event, so the common case
never waits for the lock to expire at all.

### Response capture that does not change the response

`res.write` and `res.end` are wrapped, never replaced. The original is always called with the
original arguments and its return value passed straight back, so backpressure and streaming behave
exactly as they did before. Bodies over `maxBodyBytes` (default 1 MiB) are sent to the client
normally but not stored — a large response is a bad thing to hold in Redis, and this fails towards
"retry the work" rather than towards an OOM.

---

## Options

```js
idempotency({
  store,                          // default: in-process memory (single process only)
  header: 'Idempotency-Key',
  methods: ['POST', 'PATCH', 'PUT', 'DELETE'],
  namespace: 'idem',              // key prefix, so services can share one Redis
  requireKey: false,              // bool, or (req) => bool
  scope: (req) => '',             // tenant/user boundary — set this
  ttlMs: 24 * 60 * 60 * 1000,     // how long a completed response stays replayable
  lockTtlMs: 60 * 1000,           // how long one in-flight request may hold a key
  maxBodyBytes: 1024 * 1024,      // larger responses are sent but not stored
  maxKeyLength: 255,
  retryAfterSeconds: 1,
  replayHeader: 'Idempotent-Replay',
  shouldCache: (res, req) => res.statusCode < 500 && res.statusCode !== 429,
  replayHeaderFilter: (name, value) => true,   // return false to drop a header on replay
  skip: (req) => false,
  onStoreError: 'fail-closed',    // or 'fail-open', or (err, req, res, next) => {}
  statusCodes: { required: 400, invalid: 400, mismatch: 422, conflict: 409 },
  onError: (err, message) => {}   // non-fatal diagnostics — wire this to your logger
})
```

Inside a handler, `req.idempotency` gives you `{ key, scope, storeKey, fingerprint, replayed }`.

---

## Stores

### Memory (default)

```js
const { createMemoryStore } = require('express-idempotency-keys')
idempotency({ store: createMemoryStore() })
```

Fine for a single process and for tests. **Wrong behind a load balancer or under PM2 cluster mode** —
each worker gets its own map, so a retry landing on a different worker sees no record and runs the
handler again, which is the exact failure you installed this to prevent.

### Redis

```js
const { createClient } = require('redis')   // or ioredis
const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

idempotency({ store: createRedisStore({ client }) })
```

Both `redis` (v4+) and `ioredis` are supported and auto-detected; pass `dialect` to be explicit.
This is the recommended production store — key expiry is handled by Redis itself, so there is no
lock to garbage-collect.

### MongoDB

```js
idempotency({ store: createMongoStore({ db: mongoClient.db('app') }) })
```

Uses `_id` as the storage key, so uniqueness comes from the primary index rather than a secondary one
that could drift. A TTL index on `expiresAt` is created on first use; pass `autoIndex: false` if you
manage indexes through migrations.

### Your own

Three async methods. `create` must be atomic against concurrent callers — that is the only real
requirement, and the whole guarantee rests on it.

```js
{
  async create (key, record) { /* → null if claimed, or the existing record */ },
  async complete (key, record) { /* overwrite with the finished response */ },
  async release (key) { /* drop it so the operation can be retried */ }
}
```

---

## When the store is down

The default is `fail-closed`: if Redis is unreachable, requests carrying an idempotency key get a
`503` and the handler never runs.

That is the deliberate choice for the systems this library is aimed at. `fail-open` — process the
request without protection — trades duplicate protection for availability at precisely the moment
retries are most likely, because whatever took Redis down is probably also making your API slow
enough to trigger client timeouts. A cache outage becoming double charges is a much worse afternoon
than a cache outage becoming a `503`.

If your endpoints are not dangerous to run twice, `fail-open` is a perfectly reasonable choice. Make
it on purpose:

```js
idempotency({ onStoreError: 'fail-open' })
```

---

## What this does not do

- **It does not make your handler transactional.** If your handler charges a card and then throws
  before writing to your database, this middleware faithfully prevents the *second* charge and does
  nothing about the inconsistency left by the first. Idempotency keys are a deduplication layer, not
  a substitute for getting the write path right.
- **It does not generate keys.** That is the client's job — the whole point is that the key is
  stable across the retries of one logical operation, which only the client knows.
- **It does not replay side effects.** A replayed response is bytes from the store. Nothing in your
  handler runs, including logging, metrics and webhooks. That is the intent; be aware of it when
  reading dashboards.
- **It does not cover `GET`.** Safe methods are already idempotent. Use HTTP caching.

---

## Client-side

```js
const key = crypto.randomUUID() // once per operation, reused across all its retries

await fetch('/charges', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
  body: JSON.stringify({ amount: 500 })
})
```

The mistake to avoid is generating the key inside the retry loop. A fresh key per attempt is the
same as having no key at all.

On a `409`, back off and retry with the same key — the original request is still running.

---

## Testing

```sh
npm test
```

74 tests, no test framework, no service dependencies — `node --test`, plus doubles for Redis and
Mongo that implement the expiry and atomicity the stores depend on.

There is also an integration suite that runs the same store contract against real Redis and real
MongoDB, and it earns its keep: dialect detection originally keyed off `client.sendCommand`, which
both drivers expose. The unit suite passed while real ioredis received `SET key value
[object Object]`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to run it.

---

## Prior art

The behaviour follows [Stripe's idempotency
design](https://docs.stripe.com/api/idempotent_requests) and the IETF
[`Idempotency-Key` header draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/),
which is where the `422`-on-mismatch and `409`-on-concurrent status codes come from.

---

## Support this work

This is maintained in the open, for free, by one person. If it saved you an afternoon — or a
double-charged customer — you can say thanks:

**[❤️ Sponsor](https://github.com/sponsors/milonpatowary)** · **[☕ Ko-fi](https://ko-fi.com/milonpatowary)** · [other ways, including crypto](./DONATE.md)

Not obligatory, and never a condition of support — bug reports and PRs are always welcome from
everyone.

I am also available for [retained development and platform ownership work](https://zexabit.com) if
you are building something where this class of problem matters.

---

## License

MIT © [Milon Patowary](https://github.com/milonpatowary)
