/**
 * Plugin-internal logger.
 *
 * Uses ctx.logger under the hood if available, falls back to console
 * with a tagged prefix so output is easy to filter.
 *
 * Warning / error rate limiting (M5):
 *   Without a limiter, transient error storms (e.g. TAPD 5xx spike) can
 *   flood the console and hide real signal. We bucket emit calls by
 *   (level, msgPrefix) -- the first 60 chars of the message -- and cap
 *   each bucket to 5 emits per 60s sliding window. Once a bucket trips,
 *   subsequent emits in the same window are dropped, but one synthetic
 *   summary line is emitted saying "<N> further <level> messages
 *   suppressed in last 60s". This keeps log volume bounded while still
 *   surfacing that something is going wrong.
 */
import type { Context } from '@deepseek-ai/cordis'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

interface Bucket {
  count: number
  windowStart: number
  /** Number of additional emits that happened AFTER the bucket tripped,
   *  used to compose the "N messages suppressed" line. */
  suppressed: number
  /** Have we already emitted the "suppressed" summary in this window? */
  summaryEmitted: boolean
}

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 5
const MAX_BUCKETS = 256 // hard cap so an unbounded number of distinct messages
//                        cannot leak memory; oldest bucket is evicted.

/**
 * Module-level registry, shared across all Logger instances. This means
 * a hot message key (e.g. "TAPD 503 transient") is limited even if many
 * services log it. Key = `${level}:${msgPrefix}`.
 */
const buckets = new Map<string, Bucket>()

function nowMs(): number {
  return Date.now()
}

function pruneOldestBucket(): void {
  if (buckets.size < MAX_BUCKETS) return
  // Evict the bucket with the oldest windowStart.
  let oldestKey: string | null = null
  let oldestStart = Infinity
  for (const [k, b] of buckets) {
    if (b.windowStart < oldestStart) {
      oldestStart = b.windowStart
      oldestKey = k
    }
  }
  if (oldestKey !== null) buckets.delete(oldestKey)
}

/**
 * Decide whether to emit a (level, msg) call. Returns:
 *   - 'emit'        : proceed with the normal emit
 *   - 'suppressed'  : silently drop the message (bucket tripped)
 *   - 'summary'     : emit a synthetic "<N> messages suppressed" line instead
 */
function rateGate(level: LogLevel, msg: string): 'emit' | 'suppressed' | 'summary' {
  const prefix = msg.slice(0, 60)
  const key = `${level}:${prefix}`
  const t = nowMs()
  let bucket = buckets.get(key)
  if (!bucket || t - bucket.windowStart >= WINDOW_MS) {
    // Start a fresh window.
    bucket = { count: 0, windowStart: t, suppressed: 0, summaryEmitted: false }
    pruneOldestBucket()
    buckets.set(key, bucket)
  }
  if (bucket.count < MAX_PER_WINDOW) {
    bucket.count += 1
    return 'emit'
  }
  // Bucket tripped.
  bucket.suppressed += 1
  if (!bucket.summaryEmitted) {
    bucket.summaryEmitted = true
    return 'summary'
  }
  return 'suppressed'
}

/** Test-only hook: reset the rate-limit registry. */
export function __resetLoggerRateLimit(): void {
  buckets.clear()
}

/** Test-only hook: inspect current buckets. */
export function __loggerRateLimitSnapshot(): Array<{ key: string; count: number; suppressed: number }> {
  return [...buckets.entries()].map(([key, b]) => ({
    key,
    count: b.count,
    suppressed: b.suppressed,
  }))
}

export class Logger {
  private threshold: number

  constructor(
    private readonly ctx: Context,
    level: LogLevel = 'info',
    private readonly tag: string = 'auto-rd',
  ) {
    this.threshold = LEVEL_ORDER[level]
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.threshold <= LEVEL_ORDER.debug) this.handleEmit('debug', msg, args)
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.threshold <= LEVEL_ORDER.info) this.handleEmit('info', msg, args)
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this.threshold <= LEVEL_ORDER.warn) this.handleEmit('warn', msg, args)
  }

  error(msg: string, ...args: unknown[]): void {
    if (this.threshold <= LEVEL_ORDER.error) this.handleEmit('error', msg, args)
  }

  private handleEmit(level: LogLevel, msg: string, args: unknown[]): void {
    const verdict = rateGate(level, msg)
    if (verdict === 'suppressed') return
    if (verdict === 'summary') {
      // Look up how many were suppressed in this bucket.
      const prefix = msg.slice(0, 60)
      const key = `${level}:${prefix}`
      const bucket = buckets.get(key)
      const n = bucket ? bucket.suppressed : 0
      this.emit(
        level === 'error' ? 'warn' : level, // summary is one level lower than the suppressed msgs
        `Logger: ${n} further ${level} messages suppressed in last ${WINDOW_MS / 1000}s (key=${key})`,
        [],
      )
      return
    }
    this.emit(level, msg, args)
  }

  private emit(level: LogLevel, msg: string, args: unknown[]): void {
    // Prefer the host's log channel. `ctx.logger` appears in two shapes
    // across Cordis/DSH builds — a logger instance (`ctx.logger.warn(..)`)
    // and a factory (`ctx.logger('tag').warn(..)`) — and there is no
    // `logger` entry in the host service catalog to settle which one this
    // runtime uses. resolveLogChannel accepts either, so we never lose the
    // host log through a shape mismatch. Console is the fallback only.
    const channel = resolveLogChannel(this.ctx, this.tag)
    if (channel && typeof channel[level] === 'function') {
      try {
        channel[level](msg, ...args)
        return
      } catch {
        // Never let logger failures break the plugin; fall through to console.
      }
    }
    const line = `[${this.tag}] ${level} ${msg}`
    if (args.length > 0) {
      // console has the original methods; format args plainly to keep output deterministic
      console[level === 'debug' ? 'log' : level](line, ...args)
    } else {
      console[level === 'debug' ? 'log' : level](line)
    }
  }
}

/** The method subset of a logger this plugin uses. */
export interface LogChannel {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

/**
 * Resolve the host log channel for `tag`, tolerating both shapes:
 *
 *   A. `ctx.logger` is a factory:  `ctx.logger('tag')` -> channel
 *   B. `ctx.logger` is an instance: `ctx.logger` -> channel
 *
 * Returns null when neither shape yields an object with the level
 * methods, in which case the caller falls back to console.
 */
export function resolveLogChannel(ctx: unknown, tag: string): LogChannel | null {
  const raw = (ctx as { logger?: unknown } | null | undefined)?.logger
  if (raw === undefined || raw === null) return null

  if (typeof raw === 'function') {
    // Shape A: try the factory form first.
    try {
      const produced = (raw as (t: string) => unknown).call(ctx, tag)
      if (produced && typeof produced === 'object') {
        const ch = asLogChannel(produced)
        if (ch) return ch
      }
    } catch {
      // A logger that is callable but rejects a tag argument — try shape B.
    }
    // Shape B: the function itself carries the methods.
    return asLogChannel(raw)
  }

  return asLogChannel(raw)
}

/** Narrow an unknown to a LogChannel when it exposes warn/info/error. */
function asLogChannel(value: unknown): LogChannel | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<Record<keyof LogChannel, unknown>>
  if (
    typeof candidate.warn !== 'function' ||
    typeof candidate.info !== 'function' ||
    typeof candidate.error !== 'function'
  ) {
    return null
  }
  return value as LogChannel
}