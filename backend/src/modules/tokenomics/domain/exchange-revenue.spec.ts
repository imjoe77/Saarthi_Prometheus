import { Prisma } from '@prisma/client';

import {
  decideExchangeRevenue,
  deterministicUuid,
  exchangeRevenueKeys,
  nextAttemptDelayMs,
  type ExchangeRevenuePolicy,
  type SettledExchangeOrder,
} from './exchange-revenue';

/**
 * The revenue policy is the safety-critical part of the exchange-to-tokenomics
 * bridge: everything downstream burns real treasury EMBER against the number
 * this file produces. So the tests are written from the economics outward —
 * what a settlement actually leaves behind — rather than from the config knobs.
 */

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * Rupees rendered at the paisa scale the decision is made at. `toFixed()` with
 * no argument would drop the trailing zeros, and the trailing zeros are the
 * point: they are what proves the value was floored to 2dp and not left at the
 * precision its inputs happened to arrive with.
 */
const rs = (value: Prisma.Decimal): string => value.toFixed(2);

const NONE: ExchangeRevenuePolicy = { mode: 'NONE', bps: 10_000 };
const RETAINED: ExchangeRevenuePolicy = { mode: 'RETAINED_BPS', bps: 10_000 };
const VOLUME: ExchangeRevenuePolicy = { mode: 'VOLUME_LINKED', bps: 10_000 };

/**
 * The shape every order has today: the customer's whole INR payment is credited
 * to the liquidity providers who supplied the USDT, to the paisa.
 */
function lpBackedOrder(overrides: Partial<SettledExchangeOrder> = {}): SettledExchangeOrder {
  return {
    side: 'BUY',
    customerInr: d('1000.00'),
    lpInrSettled: d('1000.00'),
    lpBacked: true,
    ...overrides,
  };
}

describe('decideExchangeRevenue', () => {
  it('attributes nothing to an order whose whole payment went to liquidity providers', () => {
    // THE headline case, and the reason the integration ships switched off.
    // Turning the policy ON does not manufacture revenue out of this order.
    const decision = decideExchangeRevenue(RETAINED, lpBackedOrder());

    expect(decision.eligible).toBe(false);
    expect(decision.reasonCode).toBe('NO_RETAINED_MARGIN');
    expect(decision.revenueInr.isZero()).toBe(true);
    expect(decision.retainedInr.isZero()).toBe(true);
  });

  it('attributes nothing under the shipped NONE mode even when a margin exists', () => {
    const decision = decideExchangeRevenue(NONE, lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('990.00') }));

    expect(decision.reasonCode).toBe('POLICY_DISABLED');
    expect(decision.revenueInr.isZero()).toBe(true);
    // The margin is still reported: the operator can see what switching on would do.
    expect(rs(decision.retainedInr)).toBe('10.00');
  });

  it('attributes the retained margin once the exchange actually keeps part of it', () => {
    const decision = decideExchangeRevenue(
      RETAINED,
      lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('990.00') }),
    );

    expect(decision.eligible).toBe(true);
    expect(decision.reasonCode).toBe('ATTRIBUTED');
    expect(rs(decision.revenueInr)).toBe('10.00');
    // Under a revenue basis the engine is sized against what was earned, so the
    // two figures are the same number. They only diverge under VOLUME_LINKED.
    expect(rs(decision.basisInr)).toBe('10.00');
  });

  it('scales the retained margin by the configured basis points', () => {
    const order = lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('990.00') });

    expect(rs(decideExchangeRevenue({ mode: 'RETAINED_BPS', bps: 6_000 }, order).revenueInr)).toBe('6.00');
    expect(rs(decideExchangeRevenue({ mode: 'RETAINED_BPS', bps: 1 }, order).revenueInr)).toBe('0.00');
  });

  it('never attributes more than was retained, whatever the rate', () => {
    // 10000 bps is "all of it" - all of the *margin*, never all of the order.
    // A misread of this knob must not be able to allocate customer principal.
    const decision = decideExchangeRevenue(
      { mode: 'RETAINED_BPS', bps: 10_000 },
      lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('999.99') }),
    );

    expect(rs(decision.revenueInr)).toBe('0.01');
    expect(decision.revenueInr.lte(decision.retainedInr)).toBe(true);
  });

  it('refuses to round a sub-paisa margin up into an allocation', () => {
    const decision = decideExchangeRevenue(
      { mode: 'RETAINED_BPS', bps: 50 },
      lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('999.99') }),
    );

    expect(decision.eligible).toBe(false);
    expect(decision.reasonCode).toBe('BELOW_INR_SCALE');
  });

  it('treats an over-credited settlement as zero margin rather than negative revenue', () => {
    // LP credits exceeding the customer debit is a bug in Module 09. This module
    // must not turn it into a negative allocation the pipeline then argues with.
    const decision = decideExchangeRevenue(
      RETAINED,
      lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('1000.02') }),
    );

    expect(decision.retainedInr.isZero()).toBe(true);
    expect(decision.revenueInr.isZero()).toBe(true);
    expect(decision.reasonCode).toBe('NO_RETAINED_MARGIN');
  });

  it('declines a legacy order whose USDT had no LP behind it', () => {
    // No providers means the settlement has no counterparty to have paid, so its
    // INR is unmatched rather than retained. Reading it as income would mint
    // burnable value out of an unbacked mint.
    const decision = decideExchangeRevenue(
      RETAINED,
      lpBackedOrder({ lpBacked: false, lpInrSettled: d('0.00') }),
    );

    expect(decision.eligible).toBe(false);
    expect(decision.reasonCode).toBe('LEGACY_NO_LP_BACKING');
    expect(decision.retainedInr.isZero()).toBe(true);
  });

  it('declines a SELL, which returns INR to the customer', () => {
    const decision = decideExchangeRevenue(RETAINED, lpBackedOrder({ side: 'SELL' }));

    expect(decision.eligible).toBe(false);
    expect(decision.reasonCode).toBe('SELL_OUT_OF_SCOPE');
  });

  it('answers what the order was before what the configuration says', () => {
    // An operator flipping the mode must not be able to make a SELL look
    // in-scope, or a legacy order look funded by a margin.
    const sell = decideExchangeRevenue(NONE, lpBackedOrder({ side: 'SELL' }));
    const legacy = decideExchangeRevenue(NONE, lpBackedOrder({ lpBacked: false, lpInrSettled: d('0') }));

    expect(sell.reasonCode).toBe('SELL_OUT_OF_SCOPE');
    expect(legacy.reasonCode).toBe('LEGACY_NO_LP_BACKING');
  });

  it('is pure: the same settlement always decides the same way', () => {
    const order = lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('990.00') });
    const before = { ...order };

    const first = decideExchangeRevenue(RETAINED, order);
    const second = decideExchangeRevenue(RETAINED, order);

    expect(second).toEqual(first);
    expect(order.customerInr.toFixed()).toBe(before.customerInr.toFixed());
    expect(order.lpInrSettled.toFixed()).toBe(before.lpInrSettled.toFixed());
  });
});

// -------------------------------------------------------------------------
// VOLUME_LINKED — the turnover basis
//
// These tests are the guard on the one thing the mode must never do: say the
// platform earned the rupees it sized against. Every case asserts revenueInr is
// zero alongside a non-zero basisInr, because that pair is the whole difference
// between this mode and a fee.
// -------------------------------------------------------------------------

describe('decideExchangeRevenue under VOLUME_LINKED', () => {
  it('sizes the engine on the order and claims no revenue', () => {
    const decision = decideExchangeRevenue(VOLUME, lpBackedOrder());

    expect(decision.eligible).toBe(true);
    expect(decision.reasonCode).toBe('VOLUME_SIZED');
    expect(rs(decision.basisInr)).toBe('1000.00');
    // The headline: ₹1,000 traded, ₹0 earned. If this ever equals the basis,
    // the mode has become a fee on the customer.
    expect(rs(decision.revenueInr)).toBe('0.00');
  });

  it('takes the basis at the paisa scale and never rounds up', () => {
    const decision = decideExchangeRevenue(VOLUME, lpBackedOrder({ customerInr: d('999.999') }));

    expect(rs(decision.basisInr)).toBe('999.99');
  });

  it('sizes a SELL too, because turnover does not care about direction', () => {
    // The revenue path refuses a SELL outright. A volume basis has nothing to
    // refuse: the order moved rupees either way, and no margin claim is being
    // made about it.
    const decision = decideExchangeRevenue(VOLUME, lpBackedOrder({ side: 'SELL' }));

    expect(decision.eligible).toBe(true);
    expect(decision.reasonCode).toBe('VOLUME_SIZED');
    expect(rs(decision.basisInr)).toBe('1000.00');
    expect(rs(decision.revenueInr)).toBe('0.00');
  });

  it('sizes an order no liquidity provider backed', () => {
    // Under a revenue basis this order's INR is unmatched and cannot be read as
    // margin. Under a volume basis it was never read as the platform's, so the
    // order is still turnover and still counts.
    const decision = decideExchangeRevenue(
      VOLUME,
      lpBackedOrder({ lpBacked: false, lpInrSettled: d('0.00') }),
    );

    expect(decision.eligible).toBe(true);
    expect(rs(decision.basisInr)).toBe('1000.00');
    // `retained` still means "left after the counterparties were paid", and an
    // unbacked settlement had none to pay. Reporting ₹1,000 retained here would
    // put customer principal in the column the dashboard labels "platform margin".
    expect(decision.retainedInr.isZero()).toBe(true);
  });

  it('ignores the basis-point rate', () => {
    // The rate belongs to the revenue basis. A volume decision at 1 bps is the
    // same size as one at 10000 bps, so an operator cannot shrink the burn by
    // reinterpreting the knob, and cannot use it to take a cut of the order.
    expect(rs(decideExchangeRevenue({ mode: 'VOLUME_LINKED', bps: 1 }, lpBackedOrder()).basisInr)).toBe('1000.00');
    expect(
      rs(decideExchangeRevenue({ mode: 'VOLUME_LINKED', bps: 0 }, lpBackedOrder()).basisInr),
    ).toBe('1000.00');
  });

  it('queues nothing for an order that settled for less than a paisa', () => {
    const decision = decideExchangeRevenue(VOLUME, lpBackedOrder({ customerInr: d('0.004') }));

    expect(decision.eligible).toBe(false);
    expect(decision.reasonCode).toBe('BELOW_INR_SCALE');
    expect(decision.basisInr.isZero()).toBe(true);
  });

  it('reports the margin it did not use', () => {
    // The settlement kept ₹10. A volume basis sizes on the ₹1,000 anyway and
    // leaves the margin visible, so switching modes never hides what the
    // exchange actually earned.
    const decision = decideExchangeRevenue(
      VOLUME,
      lpBackedOrder({ customerInr: d('1000.00'), lpInrSettled: d('990.00') }),
    );

    expect(rs(decision.retainedInr)).toBe('10.00');
    expect(rs(decision.basisInr)).toBe('1000.00');
  });

  it('is pure, so a replayed order is sized identically every time', () => {
    const order = lpBackedOrder({ side: 'SELL' });

    expect(decideExchangeRevenue(VOLUME, order)).toEqual(decideExchangeRevenue(VOLUME, order));
  });
});

describe('deterministicUuid', () => {
  it('agrees with an independent RFC 4122 v5 implementation', () => {
    // Cross-checked against CPython's uuid.uuid5 over the URL namespace, which
    // shares no code with this function. If the derivation drifts, every replay
    // key drifts with it, so this is worth pinning to a second implementation.
    expect(deterministicUuid('www.example.com')).toBe('b63cdfa4-3df9-568e-97ae-006c5b8fd652');
  });

  it('is stable for one input and different for another', () => {
    expect(deterministicUuid('a')).toBe(deterministicUuid('a'));
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
  });

  it('produces a well-formed version-5 UUID', () => {
    const value = deterministicUuid('anything');

    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('exchangeRevenueKeys', () => {
  const orderId = '11111111-1111-1111-1111-111111111111';

  it('derives the same four keys for the same order, every time', () => {
    // This is the whole replay story: a worker that crashes and re-runs sends
    // identical keys and gets the original records back.
    expect(exchangeRevenueKeys.allocation(orderId)).toBe('d330ac4f-2e2a-518c-ae7d-17255191e594');
    expect(exchangeRevenueKeys.buyback(orderId)).toBe('0bd9cb19-08e4-520f-909b-ecfeb266c5a1');
    expect(exchangeRevenueKeys.allocation(orderId)).toBe(exchangeRevenueKeys.allocation(orderId));
  });

  it('keeps the four purposes distinct so no record shadows another', () => {
    const keys = [
      exchangeRevenueKeys.allocation(orderId),
      exchangeRevenueKeys.buyback(orderId),
      exchangeRevenueKeys.directBurn(orderId),
      exchangeRevenueKeys.buybackBurn(orderId),
    ];

    expect(new Set(keys).size).toBe(4);
  });

  it('separates orders from each other', () => {
    expect(exchangeRevenueKeys.allocation(orderId)).not.toBe(exchangeRevenueKeys.allocation('2'.repeat(36)));
  });
});

describe('nextAttemptDelayMs', () => {
  it('backs off and then holds at the longest interval', () => {
    expect(nextAttemptDelayMs(1)).toBeLessThan(nextAttemptDelayMs(3));
    expect(nextAttemptDelayMs(6)).toBe(nextAttemptDelayMs(50));
  });

  it('never returns a delay that would busy-loop the queue', () => {
    for (const attempts of [0, 1, 2, 5, 99]) {
      expect(nextAttemptDelayMs(attempts)).toBeGreaterThanOrEqual(1_000);
    }
  });
});
