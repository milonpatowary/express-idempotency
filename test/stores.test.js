'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createMemoryStore, createRedisStore, createMongoStore } = require('../src/index')

process.env.NODE_ENV = 'test'

/* ------------------------------------------------------------------ *
 * Test doubles
 *
 * These implement the small slice of Redis and MongoDB the stores rely
 * on — expiry, SET NX, and duplicate-key rejection. They exist so the
 * contract below runs against all three stores in CI without a service
 * dependency. They are not a substitute for running against the real
 * thing before a release; see CONTRIBUTING.md.
 * ------------------------------------------------------------------ */

function fakeRedis ({ dialect }) {
  const data = new Map()

  const live = (key) => {
    const entry = data.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      data.delete(key)
      return null
    }
    return entry
  }

  const write = (key, value, px, nx) => {
    if (nx && live(key)) return null
    data.set(key, { value, expiresAt: Date.now() + px })
    return 'OK'
  }

  const client = {
    async get (key) {
      const entry = live(key)
      return entry ? entry.value : null
    },
    async del (key) {
      data.delete(key)
    },
    // Present on both real clients. It lives here precisely because an earlier
    // version of the double omitted it, the dialect sniffer keyed off it, and
    // the unit suite passed while real ioredis got `SET key val [object Object]`
    // and replied "ERR syntax error". A double that is missing the method that
    // breaks you is a double that agrees with your bug.
    async sendCommand () {
      throw new Error('not implemented in the double')
    }
  }

  if (dialect === 'node-redis') {
    client.pSetEx = async () => 'OK'
    client.set = async (key, value, opts) => {
      // Real node-redis takes an options object. Anything else means the store
      // picked the wrong dialect, so fail loudly rather than coercing.
      if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
        throw new Error('ERR syntax error')
      }
      return write(key, value, opts.PX, Boolean(opts.NX))
    }
  } else {
    client.psetex = async () => 'OK'
    client.set = async (key, value, ...args) => {
      // Real ioredis takes variadic flags. An options object arrives as
      // "[object Object]" and Redis rejects it, so reject it here too.
      let px = 0
      let nx = false
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'object') throw new Error('ERR syntax error')
        const flag = String(args[i]).toUpperCase()
        if (flag === 'PX') px = Number(args[++i])
        else if (flag === 'NX') nx = true
      }
      if (!px) throw new Error('ERR syntax error')
      return write(key, value, px, nx)
    }
  }

  return client
}

function fakeMongoDb () {
  const collections = new Map()

  return {
    collection (name) {
      if (!collections.has(name)) collections.set(name, new Map())
      const docs = collections.get(name)

      return {
        async createIndex () {
          return 'idempotency_ttl'
        },
        async insertOne (doc) {
          if (docs.has(doc._id)) {
            const err = new Error('E11000 duplicate key error')
            err.code = 11000
            throw err
          }
          docs.set(doc._id, { ...doc })
          return { insertedId: doc._id }
        },
        async findOne (filter) {
          const doc = docs.get(filter._id)
          return doc ? { ...doc } : null
        },
        async deleteOne (filter) {
          const doc = docs.get(filter._id)
          if (!doc) return { deletedCount: 0 }
          if (
            filter.expiresAt !== undefined &&
            new Date(doc.expiresAt).getTime() !== new Date(filter.expiresAt).getTime()
          ) {
            return { deletedCount: 0 }
          }
          docs.delete(filter._id)
          return { deletedCount: 1 }
        },
        async replaceOne (filter, doc) {
          docs.set(filter._id, { ...doc })
          return { modifiedCount: 1 }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * The contract every store must satisfy.
 * ------------------------------------------------------------------ */

const IMPLEMENTATIONS = [
  ['memory', () => createMemoryStore()],
  ['redis(ioredis)', () => createRedisStore({ client: fakeRedis({ dialect: 'ioredis' }) })],
  ['redis(node-redis)', () => createRedisStore({ client: fakeRedis({ dialect: 'node-redis' }) })],
  ['mongo', () => createMongoStore({ db: fakeMongoDb() })]
]

const inProgress = (ttlMs = 5000) => ({
  state: 'in_progress',
  fingerprint: 'fp-a',
  createdAt: Date.now(),
  expiresAt: Date.now() + ttlMs
})

for (const [name, build] of IMPLEMENTATIONS) {
  test(`${name}: the first create claims the key`, async () => {
    const store = build()
    assert.equal(await store.create('k', inProgress()), null)
  })

  test(`${name}: a competing create sees the existing record`, async () => {
    const store = build()
    await store.create('k', inProgress())

    const existing = await store.create('k', inProgress())
    assert.ok(existing, 'the second caller must be told the key is taken')
    assert.equal(existing.state, 'in_progress')
    assert.equal(existing.fingerprint, 'fp-a')
  })

  test(`${name}: only one of many concurrent creates wins`, async () => {
    const store = build()
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.create('k', inProgress()))
    )

    const winners = results.filter((r) => r === null)
    assert.equal(winners.length, 1, 'exactly one caller may hold the key')
  })

  test(`${name}: an expired record is treated as absent`, async () => {
    const store = build()
    await store.create('k', inProgress(20))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(await store.create('k', inProgress()), null, 'the stale lock is reclaimable')
  })

  test(`${name}: a completed record is returned to later callers`, async () => {
    const store = build()
    await store.create('k', inProgress())
    await store.complete('k', {
      state: 'completed',
      fingerprint: 'fp-a',
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"id":1}').toString('base64'),
      createdAt: Date.now(),
      expiresAt: Date.now() + 5000
    })

    const record = await store.create('k', inProgress())
    assert.equal(record.state, 'completed')
    assert.equal(record.statusCode, 201)
    assert.equal(Buffer.from(record.body, 'base64').toString(), '{"id":1}')
    assert.deepEqual(record.headers, { 'content-type': 'application/json' })
  })

  test(`${name}: release makes the key claimable again`, async () => {
    const store = build()
    await store.create('k', inProgress())
    await store.release('k')

    assert.equal(await store.create('k', inProgress()), null)
  })

  test(`${name}: separate keys do not interfere`, async () => {
    const store = build()
    assert.equal(await store.create('a', inProgress()), null)
    assert.equal(await store.create('b', inProgress()), null)
    assert.ok(await store.create('a', inProgress()))
  })
}

test('memory store evicts once maxEntries is reached', async () => {
  const store = createMemoryStore({ maxEntries: 3 })
  for (const key of ['a', 'b', 'c', 'd']) {
    await store.create(key, inProgress())
  }

  assert.equal(store.size(), 3, 'the map stays bounded')
  assert.equal(await store.create('a', inProgress()), null, 'the oldest key was evicted')
  store.close()
})

test('redis store rejects a missing client instead of failing later', () => {
  assert.throws(() => createRedisStore({}), /requires a `client`/)
})

test('mongo store rejects a db without .collection()', () => {
  assert.throws(() => createMongoStore({ db: {} }), /\.collection\(\)/)
})

test('an unrecognisable redis client fails at startup, not at request time', () => {
  // Both real clients expose sendCommand, so it is not a usable discriminator.
  // A client with neither psetex nor pSetEx must be rejected outright rather
  // than guessed at — guessing wrong only surfaces under production traffic.
  assert.throws(
    () => createRedisStore({ client: { get () {}, set () {}, del () {}, sendCommand () {} } }),
    /could not identify the Redis client/
  )
})

test('an explicit dialect overrides detection', async () => {
  const client = fakeRedis({ dialect: 'ioredis' })
  delete client.psetex // simulate a wrapper that hides the marker method

  const store = createRedisStore({ client, dialect: 'ioredis' })
  assert.equal(await store.create('k', inProgress()), null)
})

test('redis store namespaces keys with keyPrefix', async () => {
  const client = fakeRedis({ dialect: 'ioredis' })
  const a = createRedisStore({ client, keyPrefix: 'svc-a:' })
  const b = createRedisStore({ client, keyPrefix: 'svc-b:' })

  assert.equal(await a.create('k', inProgress()), null)
  assert.equal(await b.create('k', inProgress()), null, 'a different prefix is a different key')
})
