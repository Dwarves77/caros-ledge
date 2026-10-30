/** Bounded client retry: at most RETRY_LIMIT retries after the first attempt, exponential from one second, and a server's Retry-After wins when it is longer. */
const RETRY_LIMIT = 3;
const RETRY_BASE_MS = 1000;
/** A Retry-After past this is not waited out inside one page view: the attempt ends in the failed state and the person's Retry control starts a new round. */
const RETRY_AFTER_CAP_MS = 60_000;

/** Retry-After as milliseconds (delta-seconds or an HTTP date), or null when absent or unreadable. */
function parseRetryAfter(header: string | null | undefined, nowMs: number = Math.trunc(performance.timeOrigin + performance.now())): number | null {
  const text = (header ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** The wait before retry number `attemptsMade` (1 after the first failure), or null when the bound is spent or the server asked for longer than the cap. */
export function retryDelayMs(attemptsMade: number, retryAfterMs?: number | null): number | null {
  if (attemptsMade < 1 || attemptsMade > RETRY_LIMIT) return null;
  if (retryAfterMs != null && retryAfterMs > RETRY_AFTER_CAP_MS) return null;
  return Math.max(RETRY_BASE_MS * 2 ** (attemptsMade - 1), retryAfterMs ?? 0);
}

/** A failed fetch that says how long to wait; thrown by a fetcher so a loader can honour it. */
export class RetryableError extends Error {
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  constructor(message: string, retryAfterMs: number | null, retryable: boolean) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

/** The status of a failed response as a RetryableError: 429 and 5xx retry (429 waits its Retry-After), every other 4xx is final. */
export const failureOf = (status: number, retryAfter: string | null): RetryableError => new RetryableError(`HTTP ${status}`, parseRetryAfter(retryAfter), status === 429 || status >= 500);
