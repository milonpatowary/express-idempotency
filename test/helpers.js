'use strict'

const http = require('node:http')

/**
 * A deliberately tiny Express stand-in.
 *
 * The middleware only touches `req.method`, `req.url`, `req.headers`, `req.body`
 * and the standard `ServerResponse` API, so testing against a real Express
 * install would add a dependency without adding coverage. The `status`/`json`
 * shims exist only so `idempotencyErrorHandler` has the two methods it calls.
 */
function createTestServer (middlewares) {
  const server = http.createServer((req, res) => {
    res.status = function (code) {
      this.statusCode = code
      return this
    }
    res.json = function (value) {
      if (!this.getHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      this.end(JSON.stringify(value))
      return this
    }

    readJsonBody(req)
      .then((body) => {
        req.body = body
        runChain(middlewares, req, res)
      })
      .catch(() => {
        res.statusCode = 400
        res.end('bad body')
      })
  })

  return {
    server,
    async listen () {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      return `http://127.0.0.1:${port}`
    },
    async close () {
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

function runChain (middlewares, req, res) {
  let index = -1

  function next (err) {
    index += 1
    if (index >= middlewares.length) return finish(err)

    const layer = middlewares[index]
    const isErrorHandler = layer.length === 4

    try {
      if (err) {
        if (!isErrorHandler) return next(err)
        return layer(err, req, res, next)
      }
      if (isErrorHandler) return next()
      return layer(req, res, next)
    } catch (thrown) {
      return next(thrown)
    }
  }

  function finish (err) {
    if (res.writableEnded) return
    if (err) {
      res.statusCode = err.status || 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err.code || 'internal', message: err.message }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  }

  next()
}

function readJsonBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
  })
}

async function send (baseUrl, path, { method = 'POST', key, headers = {}, body } = {}) {
  const finalHeaders = { ...headers }
  if (key !== undefined) finalHeaders['Idempotency-Key'] = key
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'

  const res = await fetch(baseUrl + path, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }

  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text,
    json,
    replayed: res.headers.get('idempotent-replay') === 'true'
  }
}

/** A handler that records how many times it actually ran. */
function countingHandler (respond) {
  const state = { calls: 0 }
  const handler = (req, res) => {
    state.calls += 1
    respond(req, res, state.calls)
  }
  return [handler, state]
}

module.exports = { createTestServer, send, countingHandler }
