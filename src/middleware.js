'use strict'

const { fingerprintRequest, buildStoreKey, canonicalize } = require('./fingerprint')
const { captureResponse, replayResponse } = require('./capture')
const { createMemoryStore } = require('./stores/memory')
const {
  IdempotencyKeyRequiredError,
  IdempotencyKeyInvalidError,
  IdempotencyFingerprintMismatchError,
  IdempotencyConflictError
} = require('./errors')

const DEFAULTS = {
  header: 'Idempotency-Key',
  methods: ['POST', 'PATCH', 'PUT', 'DELETE'],
  namespace: 'idem',
  requireKey: false,
  ttlMs: 24 * 60 * 60 * 1000, // 24h — matches Stripe's retention window
  lockTtlMs: 60 * 1000,
  maxBodyBytes: 1024 * 1024, // 1 MiB
  maxKeyLength: 255,
  retryAfterSeconds: 1,
  replayHeader: 'Idempotent-Replay',
  onStoreError: 'fail-closed'
}

function idempotency (options = {}) {
  const opts = normalizeOptions(options)

  return function idempotencyMiddleware (req, res, next) {
    run(req, res, next, opts).catch(next)
  }
}

async function run (req, res, next, opts) {
  if (!opts.methods.has(req.method)) return next()
  if (opts.skip && (await opts.skip(req))) return next()

  const raw = req.headers[opts.headerLower]

  if (raw === undefined || raw === '') {
    const required =
      typeof opts.requireKey === 'function' ? await opts.requireKey(req) : opts.requireKey
    if (required) {
      return next(new IdempotencyKeyRequiredError(opts.header, opts.statusCodes.required))
    }
    return next()
  }

  if (Array.isArray(raw)) {
    return next(
      new IdempotencyKeyInvalidError('the header was sent more than once', opts.statusCodes.invalid)
    )
  }

  const key = raw.trim()
  if (key === '') {
    return next(new IdempotencyKeyInvalidError('the key is empty', opts.statusCodes.invalid))
  }
  if (key.length > opts.maxKeyLength) {
    return next(
      new IdempotencyKeyInvalidError(
        `the key exceeds ${opts.maxKeyLength} characters`,
        opts.statusCodes.invalid
      )
    )
  }

  const scope = String((await opts.scope(req)) ?? '')
  const storeKey = buildStoreKey(opts.namespace, scope, key)
  const fingerprint = fingerprintRequest(req, opts)

  req.idempotency = { key, scope, storeKey, fingerprint, replayed: false }

  let existing
  try {
    existing = await opts.store.create(storeKey, {
      state: 'in_progress',
      fingerprint,
      createdAt: Date.now(),
      expiresAt: Date.now() + opts.lockTtlMs
    })
  } catch (err) {
    return handleStoreError(err, req, res, next, opts)
  }

  if (existing) {
    // Guard the fingerprint before anything else. A key reused for a different
    // payload is a client bug, and replaying the first response would quietly
    // tell them their second, different request succeeded.
    if (existing.fingerprint !== fingerprint) {
      return next(new IdempotencyFingerprintMismatchError(opts.statusCodes.mismatch))
    }

    if (existing.state === 'completed') {
      req.idempotency.replayed = true
      return replayResponse(res, existing, {
        replayHeader: opts.replayHeader,
        headerFilter: opts.replayHeaderFilter
      })
    }

    // Still in flight. There is nothing to replay yet, and the whole point is
    // not to run the handler twice, so the honest answer is "ask again".
    res.setHeader('Retry-After', String(opts.retryAfterSeconds))
    return next(new IdempotencyConflictError(opts.retryAfterSeconds, opts.statusCodes.conflict))
  }

  // We hold the key. Everything from here must either store a response or
  // release the lock — a path that does neither leaves the client unable to
  // retry until the lock TTL expires.
  captureResponse(res, {
    maxBodyBytes: opts.maxBodyBytes,
    onFinish: (captured) => {
      persist(storeKey, fingerprint, captured, req, res, opts)
    },
    onAbort: () => {
      release(storeKey, opts, 'request aborted before the response completed')
    }
  })

  next()
}

function persist (storeKey, fingerprint, captured, req, res, opts) {
  if (captured.overflowed) {
    release(
      storeKey,
      opts,
      `response exceeded maxBodyBytes (${opts.maxBodyBytes}) and was not stored`
    )
    return
  }

  if (!opts.shouldCache(res, req)) {
    // Deliberately not stored: a 500 or a 429 is very often transient, and
    // caching it would turn a momentary blip into a permanently poisoned key.
    release(storeKey, opts, null)
    return
  }

  opts.store
    .complete(storeKey, {
      state: 'completed',
      fingerprint,
      statusCode: captured.statusCode,
      headers: serializeHeaders(captured.headers),
      body: captured.body.toString('base64'),
      createdAt: Date.now(),
      expiresAt: Date.now() + opts.ttlMs
    })
    .catch((err) => {
      opts.onError(err, 'failed to store the completed response')
      // The client already has its response. Dropping the lock is the least-bad
      // recovery: a retry re-runs the handler, which is worse than a replay but
      // better than a key that 409s until the lock expires.
      release(storeKey, opts, null)
    })
}

function release (storeKey, opts, reason) {
  if (reason) opts.onError(null, reason)
  opts.store.release(storeKey).catch((err) => {
    opts.onError(err, 'failed to release the idempotency key')
  })
}

function handleStoreError (err, req, res, next, opts) {
  if (typeof opts.onStoreError === 'function') {
    return opts.onStoreError(err, req, res, next)
  }

  if (opts.onStoreError === 'fail-open') {
    // Availability over duplicate protection. Read the README before choosing
    // this: it means an outage in the store silently disables idempotency at
    // precisely the moment retries are most likely.
    opts.onError(err, 'store unavailable; processing without idempotency protection')
    return next()
  }

  err.status = err.status || 503
  err.statusCode = err.status
  err.code = err.code || 'idempotency_store_unavailable'
  return next(err)
}

function serializeHeaders (headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[name] = Array.isArray(value) ? value.map(String) : String(value)
  }
  return out
}

function normalizeOptions (options) {
  const merged = { ...DEFAULTS, ...options }

  if (merged.ttlMs <= 0) throw new TypeError('`ttlMs` must be greater than zero.')
  if (merged.lockTtlMs <= 0) throw new TypeError('`lockTtlMs` must be greater than zero.')
  if (merged.lockTtlMs > merged.ttlMs) {
    throw new TypeError('`lockTtlMs` must not exceed `ttlMs`.')
  }

  return {
    ...merged,
    store: merged.store || createMemoryStore(),
    headerLower: merged.header.toLowerCase(),
    methods: new Set(merged.methods.map((m) => m.toUpperCase())),
    scope: merged.scope || (() => ''),
    canonicalizeBody: merged.canonicalizeBody || canonicalize,
    replayHeaderFilter: merged.replayHeaderFilter || null,
    skip: merged.skip || null,
    shouldCache:
      merged.shouldCache ||
      ((res) => res.statusCode < 500 && res.statusCode !== 429),
    statusCodes: {
      required: 400,
      invalid: 400,
      mismatch: 422,
      conflict: 409,
      ...(merged.statusCodes || {})
    },
    onError:
      merged.onError ||
      ((err, message) => {
        // Quiet by default in tests, loud enough to be findable in production.
        if (process.env.NODE_ENV === 'test') return
        console.warn(`[express-idempotency] ${message}`, err || '')
      })
  }
}

module.exports = { idempotency, DEFAULTS }
