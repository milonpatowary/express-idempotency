'use strict'

/**
 * A runnable example. Needs Express:
 *
 *   npm install express
 *   node examples/basic.js
 *
 * Then, in another terminal:
 *
 *   # Run it once
 *   curl -i -X POST localhost:3000/charges \
 *     -H 'Content-Type: application/json' \
 *     -H 'Idempotency-Key: key-123' \
 *     -H 'X-Tenant: acme' \
 *     -d '{"amount": 500}'
 *
 *   # Run the exact same command again — same charge id, plus Idempotent-Replay: true,
 *   # and note that the server log only ever prints "charging..." once.
 *
 *   # Reuse the key with a different amount — 422, because that is a client bug
 *   curl -i -X POST localhost:3000/charges \
 *     -H 'Content-Type: application/json' \
 *     -H 'Idempotency-Key: key-123' \
 *     -H 'X-Tenant: acme' \
 *     -d '{"amount": 900}'
 *
 *   # The same key under a different tenant is a different key entirely
 *   curl -i -X POST localhost:3000/charges \
 *     -H 'Content-Type: application/json' \
 *     -H 'Idempotency-Key: key-123' \
 *     -H 'X-Tenant: globex' \
 *     -d '{"amount": 500}'
 */

const express = require('express')
const { idempotency, idempotencyErrorHandler } = require('../src/index')

const app = express()

// The body must be parsed before the middleware runs — the fingerprint is
// computed from req.body, and an unparsed body fingerprints as empty.
app.use(express.json())

app.use(
  idempotency({
    // Default: in-process memory. Swap for createRedisStore/createMongoStore
    // the moment you run more than one process. See the README.
    scope: (req) => req.headers['x-tenant'] || 'anonymous',
    requireKey: true,
    ttlMs: 24 * 60 * 60 * 1000
  })
)

let counter = 0

app.post('/charges', async (req, res) => {
  // Stand-in for the work you actually want to happen at most once.
  console.log(`charging ${req.body.amount} for ${req.headers['x-tenant']}...`)
  await new Promise((r) => setTimeout(r, 250))

  counter += 1
  res.status(201).json({
    id: `ch_${counter}`,
    amount: req.body.amount,
    tenant: req.headers['x-tenant']
  })
})

// Optional. Drop it if you already have an error handler you would rather use —
// every error carries `.status` and `.code` for exactly that reason.
app.use(idempotencyErrorHandler())

app.listen(3000, () => {
  console.log('listening on http://localhost:3000')
})
