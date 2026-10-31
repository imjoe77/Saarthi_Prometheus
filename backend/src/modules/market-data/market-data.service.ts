import { Injectable } from '@nestjs/common';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { CandlePageDto } from './dto/candle-page.dto';
import { CandleResponseDto } from './dto/candle-response.dto';
import type { MarketCandlesQueryDto } from './dto/market-candles-query.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/**
 * MODULE 06b - reads over the imported candle history.
 *
 * TWO QUERIES AND A GUARDED THIRD. The count and the page are the whole
 * listing; the symbol-existence lookup only runs when the window is empty,
 * because that is the only moment an empty result is ambiguous - "this symbol
 * has no bar on that day" is a normal answer and "this symbol does not exist"
 * is a 404, and a count of zero is what forces the difference to be settled
 * rather than guessed.
 *
 * NO WRITE PATH. Candles arrive through `market:seed` reading files that must
 * not change, and exposing an import over HTTP would mean an endpoint that
 * reads the filesystem on request, with a body to validate and a job to
 * serialise, in exchange for a thing that happens once per dataset.
 *
 * A WINDOW WHOSE ENDS ARE BACKWARDS SELECTS NOTHING, except that it is reported
 * as 400: an empty page is a legitimate answer to "show me March" and a nonsense
 * answer to "show me March through January". Letting the first quietly produce
 * the second is how a client ends up rendering an empty chart and blaming the
 * data.
 */
@Injectable()
export class MarketDataService {
  constructor(private readonly prisma: PrismaService) {}

  async listCandles(query: MarketCandlesQueryDto): Promise<CandlePageDto> {
    const symbol = query.symbol.toUpperCase();
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;

    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw DomainException.badRequest("`from` must not be after `to`");
    }

    const where = {
      symbol,
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            day: {
              ...(query.from === undefined ? {} : { gte: new Date(`${query.from}T00:00:00.000Z`) }),
              ...(query.to === undefined ? {} : { lte: new Date(`${query.to}T00:00:00.000Z`) }),
            },
          }),
    };

    const total = await this.prisma.marketCandle.count({ where });

    if (total === 0) {
      const known = await this.prisma.marketCandle.findFirst({
        where: { symbol },
        select: { symbol: true },
      });
      if (known === null) {
        throw DomainException.notFound('Symbol', symbol);
      }
    }

    const rows = await this.prisma.marketCandle.findMany({
      where,
      orderBy: { day: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items: rows.map(CandleResponseDto.from),
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }
}
