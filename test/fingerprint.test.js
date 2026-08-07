'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { canonicalize, fingerprintRequest, buildStoreKey } = require('../src/index')

process.env.NODE_ENV = 'test'

test('object key order does not change the serialisation', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }))
  assert.equal(
    canonicalize({ outer: { z: 1, a: 2 }, list: [1, 2] }),
    canonicalize({ list: [1, 2], outer: { a: 2, z: 1 } })
  )
})

test('array order does change it, because order is meaning', () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]))
})

test('values of different types do not collide', () => {
  assert.notEqual(canonicalize('1'), canonicalize(1))
  assert.notEqual(canonicalize(null), canonicalize('null'))
  assert.notEqual(canonicalize(true), canonicalize('true'))
  assert.notEqual(canonicalize({ a: 1 }), canonicalize([{ a: 1 }]))
})

test('undefined properties are omitted, matching JSON.stringify', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }))
})

test('non-finite numbers degrade to null rather than throwing', () => {
  assert.equal(canonicalize(NaN), 'null')
  assert.equal(canonicalize(Infinity), 'null')
})

test('dates and buffers serialise by value', () => {
  const d = new Date('2026-01-01T00:00:00.000Z')
  assert.equal(canonicalize(d), canonicalize(new Date(d.getTime())))
  assert.equal(canonicalize(Buffer.from('hi')), canonicalize(Buffer.from('hi')))
  assert.notEqual(canonicalize(Buffer.from('hi')), canonicalize(Buffer.from('ho')))
})

test('a delimiter in a string cannot forge a different structure', () => {
  // The classic canonicalisation bug: {a:'1,b:2'} hashing the same as {a:1,b:2}.
  assert.notEqual(canonicalize({ a: '1,b:2' }), canonicalize({ a: 1, b: 2 }))
})

test('the fingerprint covers method, path and body', () => {
  const base = { method: 'POST', url: '/charges', body: { amount: 100 } }

  const same = fingerprintRequest({ ...base })
  assert.equal(fingerprintRequest({ ...base }), same)

  assert.notEqual(fingerprintRequest({ ...base, method: 'PUT' }), same)
  assert.notEqual(fingerprintRequest({ ...base, url: '/refunds' }), same)
  assert.notEqual(fingerprintRequest({ ...base, body: { amount: 101 } }), same)
})

test('the fingerprint ignores headers, so a refreshed token is not a mismatch', () => {
  const a = fingerprintRequest({
    method: 'POST',
    url: '/charges',
    body: { amount: 1 },
    headers: { authorization: 'Bearer old' }
  })
  const b = fingerprintRequest({
    method: 'POST',
    url: '/charges',
    body: { amount: 1 },
    headers: { authorization: 'Bearer new' }
  })

  assert.equal(a, b)
})

test('query strings are part of the path, and so part of the fingerprint', () => {
  const a = fingerprintRequest({ method: 'POST', url: '/search?q=a', body: {} })
  const b = fingerprintRequest({ method: 'POST', url: '/search?q=b', body: {} })

  assert.notEqual(a, b)
})

test('originalUrl wins over url, so a mounted router still fingerprints the full path', () => {
  const mounted = fingerprintRequest({
    method: 'POST',
    originalUrl: '/api/v1/charges',
    url: '/charges',
    body: {}
  })
  const bare = fingerprintRequest({ method: 'POST', url: '/charges', body: {} })

  assert.notEqual(mounted, bare)
})

test('store keys are scoped, namespaced and fixed-length', () => {
  const a = buildStoreKey('idem', 'tenant-a', 'key-1')
  const b = buildStoreKey('idem', 'tenant-b', 'key-1')
  const c = buildStoreKey('other', 'tenant-a', 'key-1')

  assert.notEqual(a, b, 'a key belongs to its tenant')
  assert.notEqual(a, c, 'namespaces do not collide')
  assert.equal(a, buildStoreKey('idem', 'tenant-a', 'key-1'), 'and it is stable')
  assert.equal(a.length, 'idem'.length + 1 + 64)
})

test('a hostile key cannot cross a scope boundary with a delimiter', () => {
  // Without length prefixing these would both flatten to "a\nb\nc", letting a
  // client in tenant "a" read a response stored for tenant "a\nb".
  assert.notEqual(buildStoreKey('idem', 'a', 'b\nc'), buildStoreKey('idem', 'a\nb', 'c'))
  assert.notEqual(buildStoreKey('idem', 'tenant-a', 'x'), buildStoreKey('idem', 'tenant-a\nx', ''))
  assert.notEqual(buildStoreKey('idem', '', 'a'), buildStoreKey('idem', 'a', ''))
})

test('an enormous key still produces a bounded storage key', () => {
  const key = buildStoreKey('idem', '', 'k'.repeat(100_000))
  assert.equal(key.length, 'idem'.length + 1 + 64)
})
