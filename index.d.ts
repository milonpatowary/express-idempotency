/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface IdempotencyRecord {
  state: 'in_progress' | 'completed'
  fingerprint: string
  createdAt: number
  /** Epoch milliseconds. For an in-progress record this is the lock expiry. */
  expiresAt: number
  statusCode?: number
  headers?: Record<string, string | string[]>
  /** base64-encoded response body. */
  body?: string
}

/**
 * Three methods, all async. Implement this to back the middleware with
 * something other than memory, Redis or Mongo.
 */
export interface IdempotencyStore {
  name?: string
  /**
   * Atomically claim `key`. Returns `null` if the claim succeeded, or the
   * existing (non-expired) record if someone else already holds it.
   *
   * This must be atomic against concurrent callers — it is the only thing
   * standing between a retry storm and a double charge.
   */
  create (key: string, record: IdempotencyRecord): Promise<IdempotencyRecord | null>
  /** Overwrite `key` with the completed response. */
  complete (key: string, record: IdempotencyRecord): Promise<void>
  /** Drop `key` so the operation can be retried from scratch. */
  release (key: string): Promise<void>
}

export interface IdempotencyOptions {
  /** Defaults to an in-process memory store. Not safe across processes. */
  store?: IdempotencyStore
  /** Header to read. Default `'Idempotency-Key'`. */
  header?: string
  /** Methods to guard. Default `['POST', 'PATCH', 'PUT', 'DELETE']`. */
  methods?: string[]
  /** Key prefix, so several services can share one Redis. Default `'idem'`. */
  namespace?: string
  /** Reject requests with no key. Default `false`. */
  requireKey?: boolean | ((req: any) => boolean | Promise<boolean>)
  /**
   * Tenant/user boundary for the key. Two different users sending the same key
   * must not see each other's responses — return a stable id here.
   * Default `() => ''`.
   */
  scope?: (req: any) => string | Promise<string>
  /** How long a completed response stays replayable. Default 24h. */
  ttlMs?: number
  /** How long a single in-flight request may hold the key. Default 60s. */
  lockTtlMs?: number
  /** Responses larger than this are sent but not stored. Default 1 MiB. */
  maxBodyBytes?: number
  /** Default 255. */
  maxKeyLength?: number
  /** `Retry-After` value sent with a 409. Default 1. */
  retryAfterSeconds?: number
  /** Header marking a replayed response. Default `'Idempotent-Replay'`. Set `null` to omit. */
  replayHeader?: string | null
  /**
   * Decide whether a finished response is worth storing.
   * Default: everything except 5xx and 429.
   */
  shouldCache?: (res: ServerResponse, req: IncomingMessage) => boolean
  /** Return false to drop a header from a replayed response. */
  replayHeaderFilter?: (name: string, value: string | string[]) => boolean
  /** Return true to bypass the middleware for this request. */
  skip?: (req: any) => boolean | Promise<boolean>
  /**
   * What to do when the store throws.
   * `'fail-closed'` (default) surfaces a 503. `'fail-open'` processes the
   * request without protection — read the README before choosing it.
   */
  onStoreError?: 'fail-closed' | 'fail-open' | ((err: Error, req: any, res: any, next: any) => void)
  /** Status codes for the four errors raised. */
  statusCodes?: {
    required?: number
    invalid?: number
    mismatch?: number
    conflict?: number
  }
  /** Non-fatal diagnostics. Wire this to your logger. */
  onError?: (err: Error | null, message: string) => void
  /** Override body serialisation used for the fingerprint. */
  canonicalizeBody?: (body: unknown) => string
}

export interface IdempotencyContext {
  key: string
  scope: string
  storeKey: string
  fingerprint: string
  replayed: boolean
}

export declare function idempotency (options?: IdempotencyOptions): (req: any, res: any, next: any) => void

export declare function idempotencyErrorHandler (options?: {
  format?: (err: IdempotencyError, req: any) => unknown
}): (err: any, req: any, res: any, next: any) => void

export declare function createMemoryStore (options?: {
  maxEntries?: number
  sweepIntervalMs?: number
}): IdempotencyStore & { size (): number, clear (): void, close (): void }

export declare function createRedisStore (options: {
  client: any
  dialect?: 'auto' | 'node-redis' | 'ioredis'
  keyPrefix?: string
}): IdempotencyStore

export declare function createMongoStore (options: {
  db: any
  collection?: string
  autoIndex?: boolean
}): IdempotencyStore & { ensureIndexes (): Promise<unknown> }

export declare function canonicalize (value: unknown): string
export declare function fingerprintRequest (req: any, options?: { canonicalizeBody?: (body: unknown) => string }): string
export declare function buildStoreKey (namespace: string, scope: string, key: string): string

export declare class IdempotencyError extends Error {
  status: number
  statusCode: number
  code: string
  expose: boolean
}
export declare class IdempotencyKeyRequiredError extends IdempotencyError { header: string }
export declare class IdempotencyKeyInvalidError extends IdempotencyError {}
export declare class IdempotencyFingerprintMismatchError extends IdempotencyError {}
export declare class IdempotencyConflictError extends IdempotencyError { retryAfter: number }

declare global {
  namespace Express {
    interface Request {
      idempotency?: IdempotencyContext
    }
  }
}
