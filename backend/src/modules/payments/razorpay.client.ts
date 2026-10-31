import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';

/**
 * MODULE 03b — a failure reported by the payment provider.
 *
 * The message is deliberately short and free of anything sensitive: no URL, no
 * request body, no credential. A provider error reaches the client as a plain
 * 503 and reaches the log as one line.
 */
export class PaymentsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentsProviderError';
  }
}

/** The subset of Razorpay's order response this module relies on. */
export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

export interface RazorpayOrderRequest {
  /** Prometheus' own identifier for the deposit; echoed back by Razorpay. */
  receipt: string;
  /** Amount in paise. */
  amountPaise: number;
  notes: Record<string, string>;
}

const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

/**
 * MODULE 03b — the Razorpay adapter.
 *
 * This is the ONLY code in the backend that knows Razorpay exists. The
 * payments service speaks in deposits and signatures; this class speaks in
 * Orders API calls and HMACs. Swapping the rail - which is exactly what
 * dropping test keys into the environment does - touches this file and the
 * configuration, and nothing else.
 *
 * Two signatures are verified here, and they are not the same thing:
 *
 *  - the CHECKOUT signature, `HMAC_SHA256(order_id + "|" + payment_id, key_secret)`,
 *    is what Razorpay's checkout script hands to the browser. The browser sends
 *    it back and the backend recomputes it, so a client that claims a payment
 *    it never made is caught here.
 *  - the WEBHOOK signature, `HMAC_SHA256(raw_body, webhook_secret)`, authenticates
 *    an inbound delivery. It is computed over the exact bytes received, which is
 *    why the raw body is kept (see `rawBody: true` in the bootstrap) - a
 *    re-serialised JSON body would not hash to the same value.
 *
 * Both comparisons are constant-time, and both are made against a value the
 * server derived, never against one the client supplied.
 */
@Injectable()
export class RazorpayClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** The publishable key id. Safe to hand to the browser. */
  get keyId(): string {
    return this.config.payments.razorpayKeyId;
  }

  /**
   * Creates a Razorpay order for a deposit.
   *
   * The order is created BEFORE the deposit row, because the deposit's id is
   * the order's receipt: that is what lets a webhook (which only carries the
   * order id) be matched back to a deposit without a second lookup table.
   * The cost of that order is that a failed insert leaves an unpaid order
   * behind, which Razorpay expires on its own.
   */
  async createOrder(request: RazorpayOrderRequest): Promise<RazorpayOrder> {
    const controller = new AbortController();
    const timeoutMs = this.config.payments.requestTimeoutMs;
    const timer = setTimeout(
      () => controller.abort(new PaymentsProviderError(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    try {
      const response = await globalThis.fetch(RAZORPAY_ORDERS_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(
            `${this.config.payments.razorpayKeyId}:${this.config.payments.razorpayKeySecret}`,
          ).toString('base64')}`,
        },
        body: JSON.stringify({
          amount: request.amountPaise,
          currency: 'INR',
          receipt: request.receipt,
          notes: request.notes,
          // Capture automatically, so the money is captured the moment the
          // customer pays rather than waiting for a manual capture call.
          payment_capture: 1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PaymentsProviderError(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as Partial<RazorpayOrder> | null;

      if (!body || typeof body.id !== 'string' || body.id.length === 0) {
        throw new PaymentsProviderError('response was not a valid order');
      }

      return {
        id: body.id,
        amount: typeof body.amount === 'number' ? body.amount : request.amountPaise,
        currency: typeof body.currency === 'string' ? body.currency : 'INR',
        status: typeof body.status === 'string' ? body.status : 'created',
      };
    } catch (error) {
      if (error instanceof PaymentsProviderError) {
        throw error;
      }

      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'AbortError') {
        throw new PaymentsProviderError(`timed out after ${timeoutMs}ms`);
      }

      throw new PaymentsProviderError(
        `request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verifies the checkout signature Razorpay handed to the browser.
   *
   * Returns false rather than throwing: an invalid signature is a client-side
   * fact the caller decides how to report.
   */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    const expected = createHmac('sha256', this.config.payments.razorpayKeySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    return this.constantTimeEquals(expected, signature);
  }

  /**
   * Verifies an inbound webhook delivery.
   *
   * Without a configured webhook secret nothing can be verified, so every
   * delivery is refused rather than trusted - an unauthenticated webhook would
   * otherwise be a way to credit a wallet for free.
   */
  verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    const secret = this.config.payments.razorpayWebhookSecret;

    if (!secret || !rawBody || !signature) {
      return false;
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    return this.constantTimeEquals(expected, signature);
  }

  /** Compares two hex digests without leaking their contents through timing. */
  private constantTimeEquals(expected: string, received: string): boolean {
    const expectedBytes = Buffer.from(expected, 'utf8');
    const receivedBytes = Buffer.from(received, 'utf8');

    if (expectedBytes.length !== receivedBytes.length) {
      return false;
    }

    return timingSafeEqual(expectedBytes, receivedBytes);
  }
}
