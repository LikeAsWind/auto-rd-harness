/**
 * Plugin-internal logger.
 *
 * Uses ctx.logger under the hood if available, falls back to console
 * with a tagged prefix so output is easy to filter.
 */
import type { Context } from '@deepseek-ai/cordis'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

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
    if (this.threshold <= LEVEL_ORDER.debug) this.emit('debug', msg, args)
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.threshold <= LEVEL_ORDER.info) this.emit('info', msg, args)
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this.threshold <= LEVEL_ORDER.warn) this.emit('warn', msg, args)
  }

  error(msg: string, ...args: unknown[]): void {
    if (this.threshold <= LEVEL_ORDER.error) this.emit('error', msg, args)
  }

  private emit(level: LogLevel, msg: string, args: unknown[]): void {
    const line = `[${this.tag}] ${level} ${msg}`
    if (args.length > 0) {
      // console has the original methods; format args plainly to keep output deterministic
      console[level === 'debug' ? 'log' : level](line, ...args)
    } else {
      console[level === 'debug' ? 'log' : level](line)
    }
    // Mirror to DSH logger so it shows up in the plugin's cordis logs.
    const dshLog = (this.ctx as any).logger?.[level === 'debug' ? 'debug' : level]
    if (typeof dshLog === 'function') {
      try {
        dshLog.call((this.ctx as any).logger, msg, ...args)
      } catch {
        // Never let logger failures break the plugin
      }
    }
  }
}