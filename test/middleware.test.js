'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  idempotency,
  idempotencyErrorHandler,
  createMemoryStore
} = require('../src/index')
const { createTestServer, send, countingHandler } = require('./helpers')

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

test('replays the stored response instead of running the handler twice', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res, calls) => {
    res.statusCode = 201
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ charge: 'ch_1', calls }))
  })

  await withServer([idempotency({ store }), handler], async (url) => {
    const first = await send(url, '/charges', { key: 'k1', body: { amount: 500 } })
    const second = await send(url, '/charges', { key: 'k1', body: { amount: 500 } })

    assert.equal(state.calls, 1, 'handler must run exactly once')
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.deepEqual(second.json, first.json)
    assert.equal(first.replayed, false)
    assert.equal(second.replayed, true)
  })
})

test('key ordering in the body does not break the fingerprint', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res) => {
    res.statusCode = 200
    res.end('ok')
  })

  await withServer([idempotency({ store }), handler], async (url) => {
    await send(url, '/x', { key: 'k1', body: { a: 1, b: 2 } })
    const second = await send(url, '/x', { key: 'k1', body: { b: 2, a: 1 } })

    assert.equal(state.calls, 1)
    assert.equal(second.replayed, true)
  })
})

test('same key with a different body is rejected, not replayed', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res) => {
    res.statusCode = 200
    res.end('ok')
  })

  await withServer(
    [idempotency({ store }), handler, idempotencyErrorHandler()],
    async (url) => {
      await send(url, '/charges', { key: 'k1', body: { amount: 500 } })
      const mismatch = await send(url, '/charges', { key: 'k1', body: { amount: 900 } })

      assert.equal(state.calls, 1)
      assert.equal(mismatch.status, 422)
      assert.equal(mismatch.json.error.code, 'idempotency_fingerprint_mismatch')
    }
  )
})

test('same key on a different path is rejected', async () => {
  const store = createMemoryStore()
  const handler = (req, res) => {
    res.statusCode = 200
    res.end('ok')
  }

  await withServer([idempotency({ store }), handler, idempotencyErrorHandler()], async (url) => {
    await send(url, '/charges', { key: 'k1', body: { amount: 1 } })
    const other = await send(url, '/refunds', { key: 'k1', body: { amount: 1 } })

    assert.equal(other.status, 422)
  })
})

test('scope isolates two tenants using the same key', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res, calls) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ tenant: req.headers['x-tenant'], calls }))
  })

  const middleware = idempotency({ store, scope: (req) => req.headers['x-tenant'] || '' })

  await withServer([middleware, handler], async (url) => {
    const a = await send(url, '/x', { key: 'shared', body: { v: 1 }, headers: { 'x-tenant': 'a' } })
    const b = await send(url, '/x', { key: 'shared', body: { v: 1 }, headers: { 'x-tenant': 'b' } })

    assert.equal(state.calls, 2, 'each tenant gets its own key space')
    assert.equal(a.json.tenant, 'a')
    assert.equal(b.json.tenant, 'b')
    assert.equal(b.replayed, false)
  })
})

test('requests without a key pass straight through by default', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res) => {
    res.statusCode = 200
    res.end('ok')
  })

  await withServer([idempotency({ store }), handler], async (url) => {
    await send(url, '/x', { body: { v: 1 } })
    await send(url, '/x', { body: { v: 1 } })

    assert.equal(state.calls, 2)
    assert.equal(store.size(), 0)
  })
})

test('requireKey rejects a request with no key', async () => {
  const store = createMemoryStore()
  const handler = (req, res) => res.end('ok')

  await withServer(
    [idempotency({ store, requireKey: true }), handler, idempotencyErrorHandler()],
    async (url) => {
      const res = await send(url, '/x', { body: { v: 1 } })
      assert.equal(res.status, 400)
      assert.equal(res.json.error.code, 'idempotency_key_required')
    }
  )
})

test('GET is untouched', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res) => res.end('ok'))

  await withServer([idempotency({ store }), handler], async (url) => {
    await send(url, '/x', { method: 'GET', key: 'k1' })
    await send(url, '/x', { method: 'GET', key: 'k1' })

    assert.equal(state.calls, 2)
    assert.equal(store.size(), 0)
  })
})

test('a 500 is not cached, so the retry genuinely retries', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res, calls) => {
    if (calls === 1) {
      res.statusCode = 500
      res.end('upstream blew up')
      return
    }
    res.statusCode = 200
    res.end('recovered')
  })

  await withServer([idempotency({ store }), handler], async (url) => {
    const first = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    const second = await send(url, '/x', { key: 'k1', body: { v: 1 } })

    assert.equal(first.status, 500)
    assert.equal(second.status, 200)
    assert.equal(second.text, 'recovered')
    assert.equal(state.calls, 2)
  })
})

test('a 4xx is cached, because the client caused it deterministically', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res) => {
    res.statusCode = 422
    res.end('insufficient funds')
  })

  await withServer([idempotency({ store }), handler], async (url) => {
    await send(url, '/x', { key: 'k1', body: { v: 1 } })
    const second = await send(url, '/x', { key: 'k1', body: { v: 1 } })

    assert.equal(state.calls, 1)
    assert.equal(second.status, 422)
    assert.equal(second.replayed, true)
  })
})

test('response headers survive the replay, framing headers do not', async () => {
  const store = createMemoryStore()
  const handler = (req, res) => {
    res.statusCode = 201
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Location', '/charges/ch_1')
    res.setHeader('X-Request-Id', 'req_original')
    res.end(JSON.stringify({ id: 'ch_1' }))
  }

  await withServer([idempotency({ store }), handler], async (url) => {
    await send(url, '/x', { key: 'k1', body: { v: 1 } })
    const replay = await send(url, '/x', { key: 'k1', body: { v: 1 } })

    assert.equal(replay.headers.location, '/charges/ch_1')
    assert.equal(replay.headers['x-request-id'], 'req_original')
    assert.equal(replay.headers['content-type'], 'application/json')
    assert.equal(replay.headers['content-length'], String(replay.text.length))
  })
})

test('replayHeaderFilter can drop headers that must not be replayed', async () => {
  const store = createMemoryStore()
  const handler = (req, res) => {
    res.setHeader('Set-Cookie', 'session=abc')
    res.statusCode = 200
    res.end('ok')
  }

  const middleware = idempotency({
    store,
    replayHeaderFilter: (name) => name !== 'set-cookie'
  })

  await withServer([middleware, handler], async (url) => {
    await send(url, '/x', { key: 'k1', body: { v: 1 } })
    const replay = await send(url, '/x', { key: 'k1', body: { v: 1 } })

    assert.equal(replay.headers['set-cookie'], undefined)
    assert.equal(replay.replayed, true)
  })
})

test('an oversized response is sent but not stored', async () => {
  const store = createMemoryStore()
  const big = 'x'.repeat(2048)
  const [handler, state] = countingHandler((req, res) => {
    res.statusCode = 200
    res.end(big)
  })

  await withServer([idempotency({ store, maxBodyBytes: 1024 }), handler], async (url) => {
    const first = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(first.text.length, 2048, 'the client still gets the full response')

    // Give the post-finish release a tick to land.
    await new Promise((r) => setImmediate(r))

    const second = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    assert.equal(state.calls, 2, 'nothing was stored, so the retry re-runs')
    assert.equal(second.replayed, false)
  })
})

test('a binary response round-trips byte-for-byte', async () => {
  const store = createMemoryStore()
  const payload = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00])
  const handler = (req, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.end(payload)
  }

  await withServer([idempotency({ store }), handler], async (url) => {
    await send(url, '/x', { key: 'k1', body: { v: 1 } })
    const replay = await fetch(url + '/x', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1 })
    })

    const bytes = Buffer.from(await replay.arrayBuffer())
    assert.deepEqual(bytes, payload)
  })
})

test('a chunked response is captured across multiple writes', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res) => {
    res.statusCode = 200
    res.write('one-')
    res.write('two-')
    res.end('three')
  })

  await withServer([idempotency({ store }), handler], async (url) => {
    const first = await send(url, '/x', { key: 'k1', body: { v: 1 } })
    const second = await send(url, '/x', { key: 'k1', body: { v: 1 } })

    assert.equal(first.text, 'one-two-three')
    assert.equal(second.text, 'one-two-three')
    assert.equal(state.calls, 1)
  })
})

test('an oversized key is rejected', async () => {
  const store = createMemoryStore()
  const handler = (req, res) => res.end('ok')

  await withServer([idempotency({ store }), handler, idempotencyErrorHandler()], async (url) => {
    const long = await send(url, '/x', { key: 'k'.repeat(300), body: { v: 1 } })
    assert.equal(long.status, 400)
    assert.equal(long.json.error.code, 'idempotency_key_invalid')
  })
})

test('a blank or duplicated key is rejected', async () => {
  // Exercised directly rather than over HTTP: RFC 9110 has parsers strip
  // surrounding whitespace from a field value, so a whitespace-only header
  // reaches the middleware as an empty string and is indistinguishable from an
  // absent one. The guards below still matter for non-HTTP callers and for
  // proxies that hand Node an array of repeated header values.
  const middleware = idempotency({ store: createMemoryStore() })

  const invoke = (headers) =>
    new Promise((resolve) => {
      const req = { method: 'POST', url: '/x', headers, body: { v: 1 } }
      middleware(req, {}, resolve)
    })

  const blank = await invoke({ 'idempotency-key': '   ' })
  assert.equal(blank.code, 'idempotency_key_invalid')
  assert.equal(blank.status, 400)

  const repeated = await invoke({ 'idempotency-key': ['a', 'b'] })
  assert.equal(repeated.code, 'idempotency_key_invalid')
  assert.match(repeated.message, /more than once/)

  // An absent key is not an error by default — it simply opts out.
  assert.equal(await invoke({}), undefined)
})

test('req.idempotency exposes the context to the handler', async () => {
  const store = createMemoryStore()
  const seen = []
  const handler = (req, res) => {
    seen.push({ key: req.idempotency.key, replayed: req.idempotency.replayed })
    res.statusCode = 200
    res.end('ok')
  }

  await withServer([idempotency({ store }), handler], async (url) => {
    await send(url, '/x', { key: 'k1', body: { v: 1 } })
    await send(url, '/x', { key: 'k1', body: { v: 1 } })

    assert.equal(seen.length, 1)
    assert.equal(seen[0].key, 'k1')
    assert.equal(seen[0].replayed, false)
  })
})

test('skip bypasses the middleware entirely', async () => {
  const store = createMemoryStore()
  const [handler, state] = countingHandler((req, res) => res.end('ok'))

  const middleware = idempotency({ store, skip: (req) => req.url.startsWith('/webhooks') })

  await withServer([middleware, handler], async (url) => {
    await send(url, '/webhooks/in', { key: 'k1', body: { v: 1 } })
    await send(url, '/webhooks/in', { key: 'k1', body: { v: 1 } })

    assert.equal(state.calls, 2)
    assert.equal(store.size(), 0)
  })
})
