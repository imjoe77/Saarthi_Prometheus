import { Prisma } from '@prisma/client';

import type { TriggerCondition } from './threshold';

/**
 * MODULE 14 - what Sentinel actually says on the phone.
 *
 * A PURE composer: it turns (instrument name, currency, target, observed
 * price, condition, observation time) into one concise spoken paragraph using
 * the real values, and inserts nothing it was not given. A stale-by-choice
 * said "85 rupees" when the number was 85.2 would be a fabricated price;
 * every figure here comes verbatim from the observation that caused the
 * trigger.
 *
 * SENTENCE PER THE MODULE PLAN, WITH THREE NON-NEGOTIABLE CLAUSES:
 *  1. Sentry identifies itself (Sentinel from Prometheus),
 *  2. "This is an alert only. No trade has been placed." - the product never
 *     promises execution at the target, and a call must not imply one,
 *  3. "Please review your position in Prometheus." - the action is the
 *     caller's to take.
 *
 * WHAT IS DELIBERATELY ABSENT: portfolio details, balances, symbols nobody
 * asked about, and any wording that reads as a recommendation.
 */

type MinorUnits = { readonly major: string; readonly minor: string };

/** Axes Sentinel can deploy a monetary phrase in without a database lookup. */
const CURRENCY_UNITS: Record<string, MinorUnits> = {
  USD: { major: 'dollars', minor: 'cents' },
  INR: { major: 'rupees', minor: 'paise' },
  EUR: { major: 'euros', minor: 'cents' },
  GBP: { major: 'pounds', minor: 'pence' },
};

export interface VoiceAlertMessageInput {
  readonly instrumentName: string;
  readonly currency: string;
  readonly targetPrice: string | Prisma.Decimal;
  /** The exact observed price that satisfied the condition. */
  readonly observedPrice: string | Prisma.Decimal;
  readonly condition: TriggerCondition;
  /** ISO-8601 UTC instant of the market observation, for the timestamp clause. */
  readonly observedAsOf: string;
}

/** Composes the spoken text for one triggered alert. */
export function composeVoiceAlertMessage(input: VoiceAlertMessageInput): string {
  const units =
    CURRENCY_UNITS[input.currency.toUpperCase()] ?? { major: input.currency, minor: input.currency };

  const observed = new Prisma.Decimal(input.observedPrice as Prisma.Decimal.Value);
  const target = new Prisma.Decimal(input.targetPrice as Prisma.Decimal.Value);

  const observedSpoken = speakAmount(observed, units);
  const targetSpoken = speakAmount(target, units);

  const available = speakTime(input.observedAsOf);

  return [
    'Hello. This is Sentinel from Prometheus.',
    `Your price alert for ${input.instrumentName} has been triggered.`,
    `The latest reported price is ${observedSpoken},`,
    `meeting your target of ${targetSpoken}.`,
    available,
    'This is an alert only. No trade has been placed.',
    'Please review your position in Prometheus.',
  ]
    .join(' ');
}

/**
 * Speaks one decimal amount in the currency's major/minor units.
 *
 * An amount that carries digits beyond the minor unit (a crypto quote like
 * `97123.456789`) is spoken verbatim as decimals rather than truncated to a
 * price the market did not report - exactness over rhythm.
 */
export function speakAmount(amount: Prisma.Decimal | string, units: MinorUnits): string {
  const value = new Prisma.Decimal(amount as Prisma.Decimal.Value);
  const major = value.trunc();
  const fractional = value.minus(major).abs();

  // An exact two-decimal fraction speaks as whole minor units.
  const scaled = fractional.times(100);
  if (scaled.isInteger()) {
    if (scaled.isZero()) {
      return `${major} ${units.major}`;
    }
    return `${major} ${units.major} and ${scaled.trunc()} ${units.minor}`;
  }

  return `${value.toFixed()} ${units.major}`;
}

/** "at 14:32 UTC on 23 October" - universal time, never a local guess. */
export function speakTime(asOf: string): string {
  const then = new Date(asOf);
  if (Number.isNaN(then.getTime())) {
    return '';
  }

  const hour = String(then.getUTCHours()).padStart(2, '0');
  const minute = String(then.getUTCMinutes()).padStart(2, '0');
  const day = then.getUTCDate();
  const month = then.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });

  return `The observation was recorded at ${hour}:${minute} UTC on ${day} ${month}.`;
}
