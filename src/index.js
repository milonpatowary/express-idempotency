'use strict'

const { idempotency, DEFAULTS } = require('./middleware')
const { createMemoryStore } = require('./stores/memory')
const { createRedisStore } = require('./stores/redis')
const { createMongoStore } = require('./stores/mongo')
const { canonicalize, fingerprintRequest, buildStoreKey } = require('./fingerprint')
const errors = require('./errors')

/**
 * Optional Express error handler. Mount it after your routes if you want a
 * ready-made JSON shape for the four errors this middleware raises; skip it
 * entirely if you already have an error handler you would rather keep.
 */
function idempotencyErrorHandler ({ format } = {}) {
  return function idempotencyErrorMiddleware (err, req, res, next) {
    if (!(err instanceof errors.IdempotencyError)) return next(err)
    if (res.headersSent) return next(err)

    if (err.retryAfter && !res.getHeader('Retry-After')) {
      res.setHeader('Retry-After', String(err.retryAfter))
    }

    const body = format
      ? format(err, req)
      : { error: { type: 'idempotency_error', code: err.code, message: err.message } }

    res.status(err.status).json(body)
  }
}

module.exports = {
  idempotency,
  idempotencyErrorHandler,
  createMemoryStore,
  createRedisStore,
  createMongoStore,
  canonicalize,
  fingerprintRequest,
  buildStoreKey,
  DEFAULTS,
  ...errors
}

// Also allow `const idempotency = require('express-idempotency')`.
module.exports.default = module.exports
