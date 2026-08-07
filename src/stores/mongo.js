'use strict'

const DUPLICATE_KEY = 11000

/**
 * MongoDB store. Takes a `Db` (or anything with `.collection(name)`), so it
 * works with the official driver and with `mongoose.connection.db`.
 *
 * The record `_id` *is* the storage key, which gets the uniqueness guarantee
 * from the primary index rather than from a second index that could drift.
 * A duplicate-key error on insert is therefore the signal that someone else
 * holds the key — that is the atomic primitive here, the same role `SET NX`
 * plays in the Redis store.
 *
 * A TTL index on `expiresAt` keeps the collection from growing without bound.
 * Note that Mongo's TTL monitor only sweeps about once a minute, so an expired
 * document can outlive its `expiresAt` by a little. Expiry is therefore also
 * enforced in application code below — the index is for reclaiming disk, not
 * for correctness.
 */
function createMongoStore ({
  db,
  collection = 'idempotency_keys',
  autoIndex = true
} = {}) {
  if (!db || typeof db.collection !== 'function') {
    throw new TypeError('createMongoStore requires a `db` with a .collection() method.')
  }

  const col = db.collection(collection)
  let indexPromise = null

  function ensureIndexes () {
    if (!indexPromise) {
      indexPromise = col
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'idempotency_ttl' })
        .catch((err) => {
          // Let the next call try again rather than caching a failure forever;
          // a transient index build error should not permanently disable TTL.
          indexPromise = null
          throw err
        })
    }
    return indexPromise
  }

  async function ready () {
    if (autoIndex) await ensureIndexes()
  }

  return {
    name: 'mongo',
    ensureIndexes,

    async create (key, record) {
      await ready()

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await col.insertOne({ _id: key, ...record, expiresAt: new Date(record.expiresAt) })
          return null
        } catch (err) {
          if (err?.code !== DUPLICATE_KEY) throw err
        }

        const doc = await col.findOne({ _id: key })
        if (!doc) continue // expired out from under us; try to claim it again

        if (new Date(doc.expiresAt).getTime() <= Date.now()) {
          // Reclaim an expired document. The `expiresAt` guard makes this a
          // compare-and-swap: if a competing request already reclaimed the key,
          // our delete matches nothing and the next insert loses the race
          // cleanly instead of deleting their live lock.
          await col.deleteOne({ _id: key, expiresAt: doc.expiresAt })
          continue
        }

        return toRecord(doc)
      }

      return null
    },

    async complete (key, record) {
      await ready()
      await col.replaceOne(
        { _id: key },
        { _id: key, ...record, expiresAt: new Date(record.expiresAt) },
        { upsert: true }
      )
    },

    async release (key) {
      await ready()
      await col.deleteOne({ _id: key })
    }
  }
}

function toRecord (doc) {
  const { _id, ...rest } = doc
  return { ...rest, expiresAt: new Date(doc.expiresAt).getTime() }
}

module.exports = { createMongoStore }
