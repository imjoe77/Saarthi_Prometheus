import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { toIsoDay } from '../../market-data/domain/day-window';
import type { EquityPoint } from '../../risk/domain/series';
import type { EquitySeriesPort } from '../../risk/ports/equity-series.port';

/**
 * MODULE 06b - the provider bound to Module 06's `EQUITY_SERIES_PORT`, and the
 * single reason the Risk Engine stops answering `NO_HISTORY`.
 *
 * ONE QUERY, NO INTERPOLATION. The series is the stored daily balance for the
 * strategy's simulation, ordered ascending, with `value` rendered as an
 * 18-place decimal string. Nothing is smoothed, resampled or filled in: a day
 * with no row was not observed, and the schema guarantees there are no such
 * days inside the window, so the honest series and the complete series are the
 * same series here.
 *
 * WHY THIS CLASS LIVES IN THE SIMULATION MODULE. The port is Risk's, but the
 * port says *where equity comes from*, and the answer is this module's table.
 * Binding a provider defined next to its own data keeps the dependency arrow
 * pointing one way - Risk knows the interface, Simulation knows the storage -
 * and leaves Risk's own files untouched, which is the whole point of the wiring
 * change that introduced it.
 *
 * THE IMPORTS FROM `risk/` ARE TYPES ONLY. Implementing the port means naming
 * it, and `import type` is erased at runtime, so the module graph - Risk imports
 * Simulation at runtime, Simulation never imports Risk at runtime - stays a
 * single direction. The type-level reference is the contract expressing itself,
 * not a second dependency.
 *
 * AN EMPTY ARRAY IS A VALID ANSWER. A strategy with no simulation has no
 * history, and Module 06 already treats `[]` as the `NO_HISTORY` case. Returning
 * empty rather than throwing is what lets a reader distinguish "this strategy
 * was never simulated" from "something broke", because the second would be an
 * error and the first is a fact.
 */
@Injectable()
export class PersistedDailyValueSeries implements EquitySeriesPort {
  constructor(private readonly prisma: PrismaService) {}

  async dailyPoints(strategyId: string): Promise<readonly EquityPoint[]> {
    const rows = await this.prisma.strategyDailyBalance.findMany({
      where: { simulation: { strategyId } },
      orderBy: { day: 'asc' },
      select: { day: true, value: true },
    });

    return rows.map((row) => ({
      observedAt: toIsoDay(row.day),
      equity: row.value.toFixed(18),
    }));
  }
}
