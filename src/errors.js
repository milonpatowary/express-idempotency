'use strict'

/**
 * Base class for every error this middleware surfaces. All of them are passed
 * to `next(err)` so your existing error handler stays in charge of the response
 * shape — nothing is written to the socket behind your back.
 */
class IdempotencyError extends Error {
  constructor (message, { status, code, expose = true } = {}) {
    super(message)
    this.name = this.constructor.name
    this.status = status
    // `statusCode` as well, because half the ecosystem reads one and half the other.
    this.statusCode = status
    this.code = code
    this.expose = expose
    Error.captureStackTrace?.(this, this.constructor)
  }
}

/** `requireKey: true` and the client did not send the header. */
class IdempotencyKeyRequiredError extends IdempotencyError {
  constructor (header, status = 400) {
    super(`This endpoint requires an ${header} header.`, {
      status,
      code: 'idempotency_key_required'
    })
    this.header = header
  }
}

/** The key was present but structurally unusable (empty, or over `maxKeyLength`). */
class IdempotencyKeyInvalidError extends IdempotencyError {
  constructor (reason, status = 400) {
    super(`Invalid idempotency key: ${reason}.`, {
      status,
      code: 'idempotency_key_invalid'
    })
  }
}

/**
 * Same key, different request. Almost always a client bug: a key was reused for
 * a genuinely different operation. Replaying the first response would be a lie,
 * so we refuse instead.
 */
class IdempotencyFingerprintMismatchError extends IdempotencyError {
  constructor (status = 422) {
    super(
      'This idempotency key has already been used with a different request payload.',
      { status, code: 'idempotency_fingerprint_mismatch' }
    )
  }
}

/**
 * The original request is still in flight. The client should retry — there is
 * nothing to replay yet, and running the handler twice is exactly what this
 * middleware exists to prevent.
 */
class IdempotencyConflictError extends IdempotencyError {
  constructor (retryAfterSeconds = 1, status = 409) {
    super('A request with this idempotency key is currently in progress.', {
      status,
      code: 'idempotency_conflict'
    })
    this.retryAfter = retryAfterSeconds
  }
}

module.exports = {
  IdempotencyError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyInvalidError,
  IdempotencyFingerprintMismatchError,
  IdempotencyConflictError
}
