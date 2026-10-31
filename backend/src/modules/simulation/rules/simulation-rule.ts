import type { Prisma } from '@prisma/client';

/**
 * MODULE 06b - what a trading rule is, in the narrowest terms that still let
 * three different strategies be expressed without a framework.
 *
 * A RULE IS A PURE FUNCTION OF CLOSING PRICES. It holds no position, no cash and
 * no memory of the previous day: every decision is recomputed from the closes
 * up to `t`. That is what makes a simulation reproducible - the same closes and
 * the same rule must always produce the same fills, and a rule that carried
 * internal state could not be checked that way.
 *
 * `desire` answers one question: *if you were flat, what would you want to be
 * now?* The engine owns the position and compares the answer to it, so a rule
 * never has to ask "am I holding?" and no rule can accidentally sell a position
 * it never knew it had.
 *
 * THREE ANSWERS, NOT TWO:
 *  - `long`  - be long from the next open. Also the answer when already long,
 *              which the engine reads as "do nothing".
 *  - `flat`  - be out from the next open. Also the answer when already flat.
 *  - `hold`  - no opinion today. Distinct from `flat` because a rule that is
 *              waiting for enough history must not be read as an instruction to
 *              exit a position it entered earlier.
 *
 * TIMING IS THE ENGINE'S, NOT THE RULE'S. `desire(closes, t)` may only look at
 * closes through day `t` (a close it could not have known when it decided), and
 * the engine fills at the *next* day's open. Reading `t + 1` here would be
 * look-ahead bias and would make every curve in the project worthless.
 *
 * `version` is stored with each simulation. It is not decoration: a rule whose
 * arithmetic changes is a different rule, and the curve it produced a year ago
 * should still be attributable to the algorithm that produced it.
 */
export type Desire = 'long' | 'flat' | 'hold';

export interface SimulationRule {
  /** Catalogue key stored on the simulation, e.g. `sma-cross-eth`. */
  readonly key: string;
  readonly version: number;
  /** The single symbol this rule trades. */
  readonly symbol: string;
  /** Recorded on every buy the rule triggers. */
  readonly enterNote: string;
  /** Recorded on every sell the rule triggers. */
  readonly exitNote: string;
  /**
   * The rule's opinion at the close of day `t`.
   *
   * `closes[t]` must exist. The engine only calls this for indices inside the
   * loaded window, so a rule that reads past the end is a programming error in
   * the engine, not a case a rule has to defend against.
   */
  desire(closes: readonly Prisma.Decimal[], t: number): Desire;
}
