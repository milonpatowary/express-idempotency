'use strict'

/**
 * Redis store. Works with `redis` (node-redis v4+) and `ioredis`.
 *
 * The client is injected rather than created here, so this package keeps its
 * zero-dependency promise and you keep control of connection handling,
 * clustering, TLS and retry strategy.
 *
 * Correctness rests on one primitive: `SET key value NX PX ttl`. Redis makes
 * that atomic, which means exactly one concurrent request wins the key and
 * every other one is told the operation is already in flight. Lock expiry is
 * handled by Redis itself — if the process holding a key dies mid-request, the
 * key evaporates on its own and a retry can proceed. There is no lock to
 * garbage-collect and no stale-takeover path to get subtly wrong.
 */
function createRedisStore ({ client, dialect = 'auto', keyPrefix = '' } = {}) {
  if (!client) throw new TypeError('createRedisStore requires a `client`.')

  const flavour = dialect === 'auto' ? detectDialect(client) : dialect
  const k = (key) => keyPrefix + key

  async function setIfAbsent (key, value, ttlMs) {
    if (flavour === 'node-redis') {
      return client.set(key, value, { NX: true, PX: ttlMs })
    }
    return client.set(key, value, 'PX', ttlMs, 'NX')
  }

  async function set (key, value, ttlMs) {
    if (flavour === 'node-redis') {
      return client.set(key, value, { PX: ttlMs })
    }
    return client.set(key, value, 'PX', ttlMs)
  }

  return {
    name: `redis(${flavour})`,

    async create (key, record) {
      const ttl = Math.max(1, record.expiresAt - Date.now())
      const payload = JSON.stringify(record)

      // Bounded because of a genuine (if rare) race: the NX can fail against a
      // key that expires before the follow-up GET reads it, leaving us with
      // neither the lock nor a record to act on. Retrying resolves it; looping
      // forever would not, so we give up and let the request through rather
      // than hang the caller.
      for (let attempt = 0; attempt < 3; attempt++) {
        const acquired = await setIfAbsent(k(key), payload, ttl)
        if (acquired) return null

        const raw = await client.get(k(key))
        if (raw) return parse(raw)
      }

      return null
    },

    async complete (key, record) {
      const ttl = Math.max(1, record.expiresAt - Date.now())
      await set(k(key), JSON.stringify(record), ttl)
    },

    async release (key) {
      await client.del(k(key))
    }
  }
}

function detectDialect (client) {
  // node-redis v4 generates camelCase command methods (`pSetEx`); ioredis keeps
  // the wire spelling (`psetex`). Exactly one of the two exists on any given
  // client, which makes this unambiguous.
  //
  // Do not be tempted to sniff `sendCommand` — both libraries have it, and
  // guessing wrong here sends `SET key val [object Object]` to Redis, which
  // fails at request time rather than at startup.
  if (typeof client.psetex === 'function') return 'ioredis'
  if (typeof client.pSetEx === 'function') return 'node-redis'

  throw new TypeError(
    'createRedisStore could not identify the Redis client. Pass an explicit ' +
      "`dialect: 'node-redis' | 'ioredis'`."
  )
}

function parse (raw) {
  try {
    return JSON.parse(raw)
  } catch {
    // A corrupt value is worse than a missing one: treat it as absent so the
    // key can be reclaimed instead of failing every retry forever.
    return null
  }
}

module.exports = { createRedisStore }
