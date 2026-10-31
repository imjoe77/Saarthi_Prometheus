import type { DepositCheckout } from "./api-client";

/**
 * MODULE 03b — opening Razorpay's checkout sheet.
 *
 * This is the browser half of the Razorpay rail, and the only part of the
 * deposit flow that runs outside the backend. It does three things and no
 * more: load Razorpay's checkout script once, open the payment sheet for an
 * order the backend already created, and hand back the three values Razorpay
 * signs. It never decides whether a payment happened - that is the backend's
 * job, and it re-derives the signature from the key secret it holds.
 *
 * The script is loaded from Razorpay's CDN, so this only runs in a browser.
 */

/** The three values Razorpay's checkout returns when a payment succeeds. */
export interface RazorpayCheckoutResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  theme?: { color?: string };
  handler: (response: RazorpayCheckoutResponse) => void;
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayInstance;
  }
}

const CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

/**
 * The in-flight script load, so several deposits in one session share one
 * request. Reset when a load fails, so a later attempt can try again.
 */
let scriptPromise: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("The Razorpay checkout needs a browser."));
  }

  if (window.Razorpay) {
    return Promise.resolve();
  }

  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("The Razorpay checkout could not be loaded. Check your connection and retry."));
    };

    document.body.appendChild(script);
  });

  return scriptPromise;
}

/**
 * Opens the checkout sheet and waits for the payment to complete.
 *
 * Resolves with Razorpay's signed response, or with null when the customer
 * closed the sheet without paying - which is not an error, only an unfinished
 * deposit.
 */
export async function openRazorpayCheckout(
  checkout: DepositCheckout,
): Promise<RazorpayCheckoutResponse | null> {
  await loadCheckoutScript();

  const RazorpayCheckout = window.Razorpay;

  if (!RazorpayCheckout) {
    throw new Error("The Razorpay checkout is not available.");
  }

  return new Promise<RazorpayCheckoutResponse | null>((resolve) => {
    let settled = false;

    const settle = (value: RazorpayCheckoutResponse | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const instance = new RazorpayCheckout({
      key: checkout.keyId,
      amount: checkout.amountPaise,
      currency: checkout.currency,
      order_id: checkout.orderId,
      name: "Prometheus",
      description: "Wallet top-up",
      theme: { color: "#ff5a1f" },
      handler: (response) => settle(response),
      modal: { ondismiss: () => settle(null) },
    });

    instance.open();
  });
}
