'use strict'

/**
 * The same store contract as test/stores.test.js, run against real Redis and
 * real MongoDB.
 *
 * The unit suite uses doubles, and doubles agree with whatever you believed
 * when you wrote them. This is where that belief gets checked: `SET NX PX`
 * semantics, duplicate-key error codes, TTL behaviour and driver API shapes are
 * exactly the things a hand-written fake gets subtly wrong.
 *
 *   REDIS_URL=redis://127.0.0.1:6379 MONGO_URL=mongodb://127.0.0.1:27017 \
 *     npm run test:integration
 *
 * Each backend skips cleanly if its URL is unset or its driver is not
 * installed, so this file is safe to run locally with neither.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { createRedisStore, createMongoStore } = require('../../src/index')

process.env.NODE_ENV = 'test'

const inProgress = (ttlMs = 5000) => ({
  state: 'in_progress',
  fingerprint: 'fp-a',
  createdAt: Date.now(),
  expiresAt: Date.now() + ttlMs
})

function optional (name) {
  try {
    return require(name)
  } catch {
    return null
  }
}

/** Run the shared contract against a live store. */
function contract (label, setup) {
  test(label, async (t) => {
    const ctx = await setup()
    if (!ctx) {
      t.skip('backend not configured')
      return
    }

    const { store, cleanup } = ctx
    // Namespaced per run so a rerun never collides with leftovers.
    const key = (suffix) => `it-${process.pid}-${label}-${suffix}`

    try {
      await t.test('claims, then reports the existing record', async () => {
        const k = key('claim')
        assert.equal(await store.create(k, inProgress()), null)

        const existing = await store.create(k, inProgress())
        assert.ok(existing)
        assert.equal(existing.state, 'in_progress')
        assert.equal(existing.fingerprint, 'fp-a')
      })

      await t.test('only one of many concurrent creates wins', async () => {
        const k = key('race')
        const results = await Promise.all(
          Array.from({ length: 50 }, () => store.create(k, inProgress()))
        )
        assert.equal(results.filter((r) => r === null).length, 1)
      })

      await t.test('an expired record is reclaimable', async () => {
        const k = key('expiry')
        await store.create(k, inProgress(300))
        await new Promise((r) => setTimeout(r, 500))
        assert.equal(await store.create(k, inProgress()), null)
      })

      await t.test('a completed response round-trips intact', async () => {
        const k = key('complete')
        const body = Buffer.from([0x00, 0xff, 0x7f, 0x80]).toString('base64')

        await store.create(k, inProgress())
        await store.complete(k, {
          state: 'completed',
          fingerprint: 'fp-a',
          statusCode: 201,
          headers: { 'content-type': 'application/json', 'x-multi': ['a', 'b'] },
          body,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5000
        })

        const record = await store.create(k, inProgress())
        assert.equal(record.state, 'completed')
        assert.equal(record.statusCode, 201)
        assert.equal(record.body, body)
        assert.deepEqual(record.headers['x-multi'], ['a', 'b'])
      })

      await t.test('release makes the key claimable again', async () => {
        const k = key('release')
        await store.create(k, inProgress())
        await store.release(k)
        assert.equal(await store.create(k, inProgress()), null)
      })
    } finally {
      await cleanup()
    }
  })
}

contract('redis (node-redis)', async () => {
  const redis = optional('redis')
  if (!redis || !process.env.REDIS_URL) return null

  const client = redis.createClient({ url: process.env.REDIS_URL })
  await client.connect()

  return {
    store: createRedisStore({ client, keyPrefix: 'it-node-redis:' }),
    cleanup: () => client.quit()
  }
})

contract('redis (ioredis)', async () => {
  const Redis = optional('ioredis')
  if (!Redis || !process.env.REDIS_URL) return null

  const client = new Redis(process.env.REDIS_URL)

  return {
    store: createRedisStore({ client, keyPrefix: 'it-ioredis:' }),
    cleanup: async () => {
      await client.quit()
    }
  }
})

contract('mongodb', async () => {
  const mongodb = optional('mongodb')
  if (!mongodb || !process.env.MONGO_URL) return null

  const client = new mongodb.MongoClient(process.env.MONGO_URL)
  await client.connect()

  const db = client.db('express_idempotency_it')
  const collection = `keys_${process.pid}`

  return {
    store: createMongoStore({ db, collection }),
    cleanup: async () => {
      await db.collection(collection).drop().catch(() => {})
      await client.close()
    }
  }
})
