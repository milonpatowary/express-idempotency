'use strict'

/**
 * Headers that must not survive a replay.
 *
 * `content-length` and `transfer-encoding` describe the framing of the original
 * socket write and are recomputed by Node for the replayed one. `date` should
 * reflect now, not the moment of the first request — a stale Date confuses
 * caches. The connection-management headers are hop-by-hop by definition.
 */
const STRIPPED_ON_REPLAY = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date'
])

/**
 * Buffer the response as it is written, without changing what the client
 * receives. `res.write`/`res.end` are wrapped rather than replaced: the original
 * is always called, with the original arguments, and its return value is passed
 * straight back so backpressure still works.
 */
function captureResponse (res, { maxBodyBytes, onFinish, onAbort }) {
  const chunks = []
  let bytes = 0
  let overflowed = false
  let settled = false

  const originalWrite = res.write
  const originalEnd = res.end

  function collect (chunk, encoding) {
    if (chunk === null || chunk === undefined || overflowed) return
    let buf
    if (Buffer.isBuffer(chunk)) {
      buf = chunk
    } else if (typeof chunk === 'string') {
      buf = Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
    } else {
      // A stream in object mode, or something exotic. Not safely replayable.
      overflowed = true
      return
    }

    bytes += buf.length
    if (bytes > maxBodyBytes) {
      // Stop holding the response in memory. The request still completes
      // normally for this caller; it simply will not be replayable.
      overflowed = true
      chunks.length = 0
      return
    }
    chunks.push(buf)
  }

  res.write = function write (chunk, encoding, callback) {
    collect(chunk, encoding)
    return originalWrite.call(this, chunk, encoding, callback)
  }

  res.end = function end (chunk, encoding, callback) {
    if (typeof chunk !== 'function') collect(chunk, encoding)
    return originalEnd.call(this, chunk, encoding, callback)
  }

  res.on('finish', () => {
    if (settled) return
    settled = true
    onFinish({
      statusCode: res.statusCode,
      headers: res.getHeaders(),
      body: Buffer.concat(chunks),
      overflowed
    })
  })

  // 'close' fires after 'finish' on a healthy response, and on its own when the
  // client hung up or the process tore the socket down mid-write. The `settled`
  // flag is what separates the two. An aborted request must release its lock,
  // otherwise the key stays wedged until the lock TTL expires.
  res.on('close', () => {
    if (settled) return
    settled = true
    onAbort()
  })
}

/** Write a stored response back out. */
function replayResponse (res, record, { replayHeader, headerFilter }) {
  const body = Buffer.from(record.body || '', 'base64')

  for (const [name, value] of Object.entries(record.headers || {})) {
    const lower = name.toLowerCase()
    if (STRIPPED_ON_REPLAY.has(lower)) continue
    if (headerFilter && !headerFilter(lower, value)) continue
    res.setHeader(name, value)
  }

  res.setHeader('Content-Length', String(body.length))
  if (replayHeader) res.setHeader(replayHeader, 'true')

  res.statusCode = record.statusCode
  res.end(body)
}

module.exports = { captureResponse, replayResponse, STRIPPED_ON_REPLAY }
