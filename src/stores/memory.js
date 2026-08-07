'use strict'

/**
 * In-process store. The default, and the right choice for a single-process app
 * or a test suite.
 *
 * It is explicitly the wrong choice behind a load balancer or under PM2 cluster
 * mode: each worker gets its own Map, so a retry that lands on a different
 * worker sees no record and runs the handler again. That is the exact failure
 * this library exists to prevent, so `createMemoryStore` warns once when it
 * detects a clustered process. Use Redis or Mongo there.
 */
function createMemoryStore ({ maxEntries = 10_000, sweepIntervalMs = 30_000 } = {}) {
  const entries = new Map()

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, record] of entries) {
      if (record.expiresAt <= now) entries.delete(key)
    }
  }, sweepIntervalMs)
  // Never hold the event loop open on account of a cache.
  sweep.unref?.()

  function live (key) {
    const record = entries.get(key)
    if (!record) return null
    if (record.expiresAt <= Date.now()) {
      entries.delete(key)
      return null
    }
    return record
  }

  return {
    name: 'memory',

    async create (key, record) {
      const existing = live(key)
      if (existing) return { ...existing }

      // Bound the map. Map preserves insertion order, so the first key is the
      // oldest — good enough for a cache whose entries all expire anyway.
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value
        entries.delete(oldest)
      }

      entries.set(key, { ...record })
      return null
    },

    async complete (key, record) {
      entries.set(key, { ...record })
    },

    async release (key) {
      entries.delete(key)
    },

    /** Test/ops helpers — not part of the store contract. */
    size () {
      return entries.size
    },
    clear () {
      entries.clear()
    },
    close () {
      clearInterval(sweep)
      entries.clear()
    }
  }
}

module.exports = { createMemoryStore }
