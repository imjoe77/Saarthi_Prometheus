/**
 * The globals the trade-buddy widget reads from the page.
 *
 * `PROMETHEUS_AI_CONFIG` is published by the root layout before the widget
 * loads, and names the routes it may talk to. `PROMETHEUS_PAGE_CONTEXT` is
 * published by a page that knows what the reader is looking at - the
 * copy-trading page does - and is cleared when that page unmounts.
 *
 * Both carry pointers, never numbers: the page says which trade is in view,
 * and the server reads what that trade was from its own ledger.
 */
export {};

declare global {
  interface Window {
    PROMETHEUS_AI_CONFIG?: {
      /** The general knowledge-base route. */
      apiEndpoint?: string;
      /** The authenticated ledger route, for questions about the caller's own trades. */
      copyEndpoint?: string;
      modelName?: string;
    };
    PROMETHEUS_PAGE_CONTEXT?: {
      /** Which page this is, e.g. "copy-trading". */
      page?: string;
      /** The market in view, e.g. "BTC/USD". */
      symbol?: string | null;
      /** The row in view, e.g. "copy-event:<expertOrderId>". */
      focusId?: string | null;
    };
  }
}
