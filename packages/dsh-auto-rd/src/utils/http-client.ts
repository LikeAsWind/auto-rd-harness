/**
 * HttpClient — minimal fetch wrapper with timeout, retry, and structured errors.
 *
 * Why a wrapper?
 *   - DSH's host runtime exposes `ctx.web.fetch`, but the auto-rd plugin
 *     may also be exercised in unit tests via Node's built-in fetch. We
 *     don't import either directly; instead we accept a `fetcher` so the
 *     test harness can swap in a fake server, a mock function, or the
 *     real DSH service.
 *   - Network errors must be classifiable: 401 ≠ 500 ≠ timeout. The
 *     pipeline uses the distinction to decide whether to retry (5xx,
 *     network error, timeout) or surface immediately (4xx auth).
 *   - Every request gets a stable Request-Id header so TAPD / GitLab
 *     support tickets can correlate when something goes wrong.
 *
 * Retry policy:
 *   - Up to `maxRetries` retries on 5xx / network / timeout.
 *   - Exponential backoff: 250ms, 500ms, 1s, 2s, ... (capped at 5s).
 *   - 4xx (other than 408 / 429) is NOT retried — caller likely has a
 *     contract error and retrying won't help.
 *   - 429 (rate limited) is retried with backoff if a Retry-After header
 *     is present; otherwise standard backoff.
 *
 * NOT in scope here:
 *   - Persistent connection pooling (Node fetch handles it).
 *   - Body streaming (responses are small JSON in auto-rd).
 *   - Auth header construction (callers compose Authorization headers).
 */
export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Plain object — serialized as JSON. If `body` is a string, sent as-is. */
  body?: unknown
  headers?: Record<string, string>
  /**
   * Per-request timeout in ms. Defaults to the client's `defaultTimeoutMs`.
   * Set lower than 1000 for tight retry loops, or higher for slow endpoints.
   */
  timeoutMs?: number
}

export interface HttpResponse<T = unknown> {
  status: number
  headers: Record<string, string>
  /** Parsed JSON body if Content-Type is JSON and parse succeeded. */
  json<T = unknown>(): T
  /** Raw body as text. */
  text(): string
}

/**
 * Subset of the Web Fetch API we depend on. Both Node 18+ `fetch` and
 * DSH's `ctx.web.fetch` match this shape.
 */
export type Fetcher = (
  url: string,
  init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
    signal: AbortSignal
  },
) => Promise<{
  status: number
  headers: Headers
  text(): Promise<string>
}>

export interface HttpClientOptions {
  fetcher?: Fetcher
  defaultTimeoutMs?: number
  maxRetries?: number
  /** Base backoff in ms; doubles per attempt up to 5000. */
  baseBackoffMs?: number
  /** Sleep function — injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Tag for log correlation. */
  tag?: string
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly transient: boolean,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export class HttpTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`HTTP request to ${url} timed out after ${timeoutMs}ms`)
    this.name = 'HttpTimeoutError'
  }
}

export class HttpNetworkError extends Error {
  constructor(public readonly url: string, public readonly cause: unknown) {
    super(`HTTP request to ${url} failed: ${(cause as Error)?.message ?? 'unknown'}`)
    this.name = 'HttpNetworkError'
  }
}

export class HttpClient {
  private readonly fetcher: Fetcher
  private readonly defaultTimeoutMs: number
  private readonly maxRetries: number
  private readonly baseBackoffMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly tag: string

  constructor(opts: HttpClientOptions = {}) {
    // Default to Node 18+'s built-in fetch. DSH injects its own via
    // HttpClient({ fetcher: ctx.web.fetch.bind(ctx.web) }).
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, init as RequestInit))
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000
    this.maxRetries = opts.maxRetries ?? 3
    this.baseBackoffMs = opts.baseBackoffMs ?? 250
    this.sleep =
      opts.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.tag = opts.tag ?? 'auto-rd-http'
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const method = req.method ?? 'GET'
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs
    const body =
      req.body === undefined
        ? undefined
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body)

    const headers: Record<string, string> = {
      'X-Request-Id': `${this.tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(req.headers ?? {}),
    }

    let lastErr: Error | null = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const raw = await this.fetcher(req.url, {
          method,
          headers,
          body,
          signal: controller.signal,
        })
        clearTimeout(timer)

        const status = raw.status
        const respHeaders: Record<string, string> = {}
        raw.headers.forEach((v, k) => {
          respHeaders[k] = v
        })
        const text = await raw.text()

        // 2xx — success.
        if (status >= 200 && status < 300) {
          return {
            status,
            headers: respHeaders,
            json<T>() {
              return parseJsonSafe<T>(text, respHeaders)
            },
            text() {
              return text
            },
          }
        }

        // 429 — rate limited. Respect Retry-After if present, otherwise backoff.
        if (status === 429) {
          const retryAfter = parseRetryAfter(respHeaders['retry-after'])
          lastErr = new HttpError(
            `HTTP 429 from ${req.url} (attempt ${attempt + 1})`,
            status,
            text,
            true,
          )
          if (attempt < this.maxRetries) {
            await this.sleep(retryAfter ?? this.backoff(attempt))
            continue
          }
          throw lastErr
        }

        // 5xx — transient server error. Retry with backoff.
        if (status >= 500) {
          lastErr = new HttpError(
            `HTTP ${status} from ${req.url} (attempt ${attempt + 1})`,
            status,
            text,
            true,
          )
          if (attempt < this.maxRetries) {
            await this.sleep(this.backoff(attempt))
            continue
          }
          throw lastErr
        }

        // 408 Request Timeout — transient.
        if (status === 408) {
          lastErr = new HttpError(
            `HTTP 408 from ${req.url} (attempt ${attempt + 1})`,
            status,
            text,
            true,
          )
          if (attempt < this.maxRetries) {
            await this.sleep(this.backoff(attempt))
            continue
          }
          throw lastErr
        }

        // Other 4xx — caller bug. Do NOT retry.
        throw new HttpError(
          `HTTP ${status} from ${req.url}: ${text.slice(0, 500)}`,
          status,
          text,
          false,
        )
      } catch (err) {
        clearTimeout(timer)
        if (err instanceof HttpError) throw err

        if ((err as { name?: string }).name === 'AbortError') {
          lastErr = new HttpTimeoutError(req.url, timeoutMs)
        } else {
          lastErr = new HttpNetworkError(req.url, err)
        }

        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt))
          continue
        }
        throw lastErr
      }
    }

    // Unreachable; the loop above either returns or throws.
    throw lastErr ?? new Error('HttpClient: exhausted retries')
  }

  private backoff(attempt: number): number {
    return Math.min(this.baseBackoffMs * 2 ** attempt, 5_000)
  }
}

function parseJsonSafe<T>(text: string, headers: Record<string, string>): T {
  const ct = headers['content-type'] ?? ''
  if (!ct.toLowerCase().includes('json') && text.trim().length > 0 && !text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    // Server said non-JSON; do not guess. Surface raw text instead.
    throw new HttpError('Expected JSON response but Content-Type is not JSON', 200, text, false)
  }
  return JSON.parse(text) as T
}

function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null
  const asInt = parseInt(value, 10)
  if (!Number.isNaN(asInt) && asInt >= 0) return Math.min(asInt * 1000, 30_000)
  // HTTP-date form — for now we ignore it. Most rate-limited APIs use
  // the delta-seconds form. Real DSH integration would parse the date.
  return null
}