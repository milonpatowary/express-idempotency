'use strict'

const { createHash } = require('node:crypto')

/**
 * Deterministic serialisation of a parsed request body.
 *
 * `JSON.stringify` is not stable: two structurally identical objects can
 * serialise differently depending on key insertion order, which would make an
 * honest retry look like a fingerprint mismatch. Object keys are sorted here so
 * that `{a:1,b:2}` and `{b:2,a:1}` hash to the same value. Array order is
 * preserved, because for an array order is meaning.
 */
function canonicalize (value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'string') return JSON.stringify(value)
  if (type === 'bigint') return `${value}n`

  if (Buffer.isBuffer(value)) return `b64:${value.toString('base64')}`
  if (value instanceof Date) return `date:${value.toISOString()}`

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }

  if (type === 'object') {
    const keys = Object.keys(value).sort()
    const parts = []
    for (const key of keys) {
      if (value[key] === undefined) continue // match JSON.stringify's omission
      parts.push(`${JSON.stringify(key)}:${canonicalize(value[key])}`)
    }
    return `{${parts.join(',')}}`
  }

  // Functions, symbols — not representable, and not something a body should hold.
  return 'null'
}

/**
 * Hash of everything about this request that must not change between retries.
 *
 * Deliberately excludes headers and query-string ordering noise: the client is
 * allowed to retry with a different User-Agent or a fresh auth token, and
 * should not be punished for it.
 */
function fingerprintRequest (req, { canonicalizeBody = canonicalize } = {}) {
  const path = (req.originalUrl || req.url || '').split('#')[0]
  const body = req.body === undefined ? '' : canonicalizeBody(req.body)

  return sha256([req.method, path, body].join('\n'))
}

/**
 * The storage key. Three things go in:
 *
 *   namespace — lets several services share one Redis without colliding
 *   scope     — the tenant/user boundary; see the `scope` option
 *   key       — the client-supplied Idempotency-Key
 *
 * It is hashed rather than concatenated so that key length stays bounded no
 * matter what the client sends.
 *
 * The parts are length-prefixed rather than merely delimited. Joining on a
 * separator alone is forgeable: scope `a` with key `b\nc` and scope `a\nb` with
 * key `c` both flatten to `a\nb\nc`, which would let a client in one tenant
 * reach another tenant's stored response by choosing its key carefully.
 * Prefixing each part with its length removes the ambiguity entirely.
 */
function buildStoreKey (namespace, scope, key) {
  const s = String(scope)
  const k = String(key)
  return `${namespace}:${sha256(`${s.length}:${s}\n${k.length}:${k}`)}`
}

function sha256 (input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

module.exports = { canonicalize, fingerprintRequest, buildStoreKey, sha256 }
