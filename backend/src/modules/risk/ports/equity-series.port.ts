import type { EquityPoint } from '../domain/series';

/**
 * MODULE 06 - the boundary between the Risk Engine and any source of equity
 * history, and the token by which that source is supplied.
 *
 * THE RISK ENGINE DOES NOT PRODUCE EQUITY. No table records a strategy's
 * equity over time, so today there is nothing to measure and every request
 * honestly returns `NO_HISTORY`. The port exists so that fact is an
 * *implementation detail of the provider* rather than a property of the risk
 * domain: when a later module decides how equity is recorded, it supplies a
 * provider that satisfies this interface and the Risk Engine measures it with
 * no change to any file here. The token is injected rather than imported, so
 * which provider a consumer receives is decided by module wiring.
 *
 * READ-ONLY, AROUND A SOURCE THAT DOES NOT EXIST YET. The interface is a single
 * query with no writes, no filters and no pagination - it describes the whole
 * daily series for one strategy, which is exactly what the measurements need.
 * Nothing here may infer, interpolate or otherwise manufacture a point: the
 * contract is about what *was* observed, and the evidence a response reports
 * must be the evidence it was given.
 */
export const EQUITY_SERIES_PORT = Symbol('EQUITY_SERIES_PORT');

export interface EquitySeriesPort {
  /**
   * Daily equity observations for one strategy, ascending by UTC date.
   *
   * Resolves to an empty array when a strategy has no history - never to null,
   * and never to a partially filled series. Callers treat "no history" as the
   * `NO_HISTORY` case and any contract violation as `INVALID_SERIES`.
   */
  dailyPoints(strategyId: string): Promise<readonly EquityPoint[]>;
}

/**
 * The provider registered today: no source of equity history exists yet, so it
 * returns none.
 *
 * An empty result is the module's honest current state, not a stub waiting to
 * be filled in. It is a real implementation of the port, and it is why every
 * response in this release reads `INSUFFICIENT_DATA / NO_HISTORY` instead of a
 * number.
 */
export class EmptyEquitySeries implements EquitySeriesPort {
  dailyPoints(): Promise<readonly EquityPoint[]> {
    return Promise.resolve([]);
  }
}
