/**
 * MODULE 06 - the risk evaluation, as a domain result.
 *
 * NOTHING HERE IS STORED. Every value is computed from an equity series at
 * request time and discarded, which is what stops a risk figure from drifting
 * away from the evidence that produced it. There is no `risk` table, no column
 * on `strategies` and no snapshot, so no stale reading can be rendered as a
 * current one.
 *
 * THE TWO STATES, AND WHY THERE IS NO THIRD. `EVALUATED` means enough
 * observations exist to support a statement. `INSUFFICIENT_DATA` means they do
 * not, and it carries a reason so a client can say *why* rather than showing a
 * zero. There is deliberately no third state that renders a placeholder
 * estimate: a number standing in for an absent measurement is indistinguishable
 * from a measured one once it reaches a screen, and a follower sizing a position
 * against it would have no way to tell.
 */

/**
 * Whether enough evidence exists to state anything at all.
 *
 * `INSUFFICIENT_DATA` is a normal, successful answer - hence 200 rather than an
 * error status. The request was well formed and the strategy was visible; it
 * simply has no history yet.
 */
export type RiskStatus = 'EVALUATED' | 'INSUFFICIENT_DATA';

/**
 * Why a status is what it is. A closed set: exactly one reason is ever
 * returned, chosen by the precedence validation → observation count →
 * flatness, so two reasons can never compete for the same response.
 */
export type RiskReason = 'NO_HISTORY' | 'INSUFFICIENT_HISTORY' | 'NO_ACTIVITY' | 'INVALID_SERIES';

/**
 * The classification vocabulary. Absent (`null`) unless the status is
 * `EVALUATED` - there is no default of LOW, because an unmeasured strategy
 * classified as safe is the one claim this module exists to make impossible.
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * The three risk measurements, all dimensionless ratios expressed on [0, 1]
 * for volatility's daily figure and unbounded only in the annualised one.
 *
 * These are *risk* and nothing else. Return, P&L, Sharpe, win rate and their
 * relatives describe gain and belong to a later performance module; a price
 * series or a risk-free rate would be needed even to attempt them.
 */
export interface RiskMetrics {
  /** Largest peak-to-trough decline in the series, as a fraction of the peak. */
  readonly maxDrawdown: number;
  /** Sample standard deviation of daily simple returns. */
  readonly dailyVolatility: number;
  /** Daily volatility scaled to a year by the fixed √252 constant. */
  readonly annualisedVolatility: number;
}

/**
 * What the statement was made from, so an empty state can be explained in
 * words instead of rendered as a zero.
 *
 * The dates are null when there are no observations, and stay null when the
 * series itself was rejected - reporting dates from data we refused to trust
 * would imply we trusted it.
 */
export interface RiskEvidence {
  /** Observations offered for evaluation. */
  readonly observations: number;
  /** UTC day of the first observation, ISO-8601 date, or null. */
  readonly firstObservedAt: string | null;
  /** UTC day of the last observation, ISO-8601 date, or null. */
  readonly lastObservedAt: string | null;
  /** The policy this evaluation was held to, echoed so a client need not hard-code it. */
  readonly requiredObservations: number;
  /** What one observation is, in words. */
  readonly sampleDescription: string;
}

/**
 * One complete risk reading for one strategy.
 *
 * `metrics` and `riskLevel` are null together: they are the same claim, and
 * returning one without the other would let a client render a level it cannot
 * substantiate or a figure it cannot classify.
 */
export interface RiskEvaluation {
  readonly strategyId: string;
  readonly status: RiskStatus;
  readonly reason: RiskReason | null;
  readonly riskLevel: RiskLevel | null;
  readonly metrics: RiskMetrics | null;
  readonly evidence: RiskEvidence;
  /** When this evaluation ran, not when any observation was made. */
  readonly evaluatedAt: string;
}
