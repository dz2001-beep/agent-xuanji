/** Small shared helpers. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Truncate a string from the end, keeping the head (most LLM-relevant part). */
export function truncate(text: string, max = 20_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** Best-effort stringification of an arbitrary tool result. */
export function stringify(data: unknown, max = 20_000): string {
  if (typeof data === 'string') return truncate(data, max);
  if (data === undefined) return 'undefined';
  try {
    return truncate(JSON.stringify(data, null, 2), max);
  } catch {
    return truncate(String(data), max);
  }
}

/** Create an AbortError-compatible error (DOMException exists on Node >= 17). */
export function abortError(message = 'Operation aborted'): Error {
  try {
    return new DOMException(message, 'AbortError');
  } catch {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
  }
}

export function isAbortError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Race a promise against a timeout. The underlying operation keeps running
 * (it cannot be cancelled in general) but its result is discarded.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
