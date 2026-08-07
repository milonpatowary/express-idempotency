'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { idempotency, idempotencyErrorHandler, createMemoryStore } = require('../src/index')
const { createTestServer, send } = require('./helpers')

process.env.NODE_ENV = 'test'

async function withServer (middlewares, fn) {
  const app = createTestServer(middlewares)
  const url = await app.listen()
  try {
    await fn(url)
  } finally {
    await app.close()
  }
}

/** A latch so a test can hold a request open at a known point and release it. */
function latch () {
  let release
  const entered = []
  const gate = new Promise((resolve) => {
    release = resolve
  })
  return {
    gate,
    release: (...args) => release(...args),
    entered,
    waitForEntry (n = 1) {
      return new Promise((resolve) => {
        const check = () => (entered.length >= n ? resolve() : setTimeout(check, 5))
        check()
      })
    }
  }
}

test('a second request arriving mid-flight gets 409, not a duplicate execution', async () => {
  const store = createMemoryStore()
  const l = latch()
  let calls = 0

  const handler = async (req, res) => {
    calls += 1
    l.entered.push(1)
    await l.gate
    res.statusCode = 201
    res.end('done')
  }

  await withServer(
    [idempotency({ store }), handler, idempotencyErrorHandler()],
    async (url) => {
      const first = send(url, '/charges', { key: 'k1', body: { amount: 100 } })
      await l.waitForEntry()

      const second = await send(url, '/charges', { key: 'k1', body: { amount: 100 } })
      assert.equal(second.status, 409)
      assert.equal(second.json.error.code, 'idempotency_conflict')
      assert.equal(second.headers['retry-after'], '1')
      assert.equal(calls, 1, 'the handler must not have run a second time')

      l.release()
      const firstResult = await first
      assert.equal(firstResult.status, 201)
    }
  )
})

test('a burst of identical requests executes the handler exactly once', async () => {
  const store = createMemoryStore()
  let calls = 0

  const handler = async (req, res) => {
    calls += 1
    await new Promise((r) => setTimeout(r, 40))
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: 'once' }))
  }

  await withServer(
    [idempotency({ store }), handler, idempotencyErrorHandler()],
    async (url) => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => send(url, '/charges', { key: 'burst', body: { v: 1 } }))
      )

      assert.equal(calls, 1, 'exactly one execution across the whole burst')

      const ok = results.filter((r) => r.status === 200)
      const conflicts = results.filter((r) => r.status === 409)

      assert.equal(ok.length + conflicts.length, 12, 'every response is either the result or a 409')
      assert.ok(ok.length >= 1, 'at least one request gets the real response')
      for (const r of ok) assert.deepEqual(r.json, { id: 'once' })
    }
  )
})

test('an expired lock is reclaimed so a wedged key does not block forever', async () => {
  const store = createMemoryStore()
  const l = latch()
  let calls = 0

  const handler = async (req, res) => {
    calls += 1
    if (calls === 1) {
      l.entered.push(1)
      await l.gate // first request hangs past the lock TTL
    }
    res.statusCode = 200
    res.end(`call-${calls}`)
  }

  await withServer(
    [idempotency({ store, lockTtlMs: 60, ttlMs: 60_000 }), handler, idempotencyErrorHandler()],
    async (url) => {
      const first = send(url, '/x', { key: 'k1', body: { v: 1 } })
      await l.waitForEntry()
      await new Promise((r) => setTimeout(r, 120)) // outlive the lock

      const second = await send(url, '/x', { key: 'k1', body: { v: 1 } })
      assert.equal(second.status, 200)
      assert.equal(second.text, 'call-2', 'the stale lock was reclaimed')

      l.release()
      await first
    }
  )
})

test('a completed record stops replaying once its TTL passes', async () => {
  const store = createMemoryStore()
  let calls = 0
  const handler = (req, res) => {
    calls += 1
    res.statusCode = 200
    res.end(`call-${calls}`)
  }

  await withServer([idempotency({ store, ttlMs: 80, lockTtlMs: 80 }), handler], async (url) => {
    const first = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(first.text, 'call-1')

    const replay = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(replay.text, 'call-1')
    assert.equal(replay.replayed, true)

    await new Promise((r) => setTimeout(r, 140))

    const afterExpiry = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(afterExpiry.text, 'call-2')
    assert.equal(afterExpiry.replayed, false)
  })
})

test('a client that disconnects mid-request releases the key', async () => {
  const store = createMemoryStore()
  const l = latch()
  let calls = 0

  const handler = async (req, res) => {
    calls += 1
    if (calls === 1) {
      l.entered.push(1)
      await new Promise((r) => setTimeout(r, 200))
    }
    res.statusCode = 200
    res.end(`call-${calls}`)
  }

  await withServer([idempotency({ store, lockTtlMs: 30_000 }), handler], async (url) => {
    const controller = new AbortController()
    const aborted = fetch(url + '/x', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1 }),
      signal: controller.signal
    }).catch(() => {})

    await l.waitForEntry()
    controller.abort()
    await aborted

    // Wait for the socket teardown to reach the 'close' handler.
    await new Promise((r) => setTimeout(r, 100))

    const retry = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(retry.status, 200)
    assert.equal(retry.text, 'call-2', 'the abandoned key was released, not left locked')
  })
})

test('fail-closed turns a broken store into a 503 rather than a silent double charge', async () => {
  const brokenStore = {
    async create () {
      throw new Error('redis is down')
    },
    async complete () {},
    async release () {}
  }

  let calls = 0
  const handler = (req, res) => {
    calls += 1
    res.end('ok')
  }

  await withServer([idempotency({ store: brokenStore }), handler], async (url) => {
    const res = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(res.status, 503)
    assert.equal(calls, 0, 'the handler never ran')
  })
})

test('fail-open lets the request through when the store is unavailable', async () => {
  const brokenStore = {
    async create () {
      throw new Error('redis is down')
    },
    async complete () {},
    async release () {}
  }

  let calls = 0
  const handler = (req, res) => {
    calls += 1
    res.statusCode = 200
    res.end('ok')
  }

  const middleware = idempotency({
    store: brokenStore,
    onStoreError: 'fail-open',
    onError: () => {}
  })

  await withServer([middleware, handler], async (url) => {
    const res = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(res.status, 200)
    assert.equal(calls, 1)
  })
})
