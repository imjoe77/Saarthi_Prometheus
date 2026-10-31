import { UsdtProviderError } from './usdt-pricing.types';

/**
 * MODULE 08 extension — one guarded JSON fetch for the USDT pricing providers.
 *
 * Every provider call is bounded by a timeout (an AbortController timer, the
 * same pattern as the Alpaca market-data provider) and by an HTTP status
 * check. Failures throw {@link UsdtProviderError} with the source label and a
 * short, safe reason - never the response body and never the URL, so a
 * credential in a header or query can never surface in a log line or an error
 * envelope. This deliberately uses Node's global fetch: the runtime already
 * provides it, and a pricing extension is not a reason to add an HTTP client
 * dependency.
 */
export async function fetchJsonWithTimeout(
  url: string,
  source: string,
  options: { timeoutMs: number; headers?: Record<string, string> },
): Promise<unknown> {
  const controller = new AbortController();
  // Abort with our own error as the reason: fetch rejects with exactly that
  // value, so the timeout is labelled correctly in every realm (a DOMException
  // from another realm fails `instanceof Error` under Jest's VM).
  const timer = setTimeout(
    () => controller.abort(new UsdtProviderError(source, `timed out after ${options.timeoutMs}ms`)),
    options.timeoutMs,
  );

  try {
    const response = await globalThis.fetch(url, {
      headers: { accept: 'application/json', ...options.headers },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new UsdtProviderError(source, `HTTP ${response.status}`);
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new UsdtProviderError(source, 'response was not valid JSON');
    }
  } catch (error) {
    if (error instanceof UsdtProviderError) {
      throw error;
    }
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'AbortError') {
      throw new UsdtProviderError(source, `timed out after ${options.timeoutMs}ms`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsdtProviderError(source, `request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
