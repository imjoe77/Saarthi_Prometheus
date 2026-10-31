import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CandlePageDto } from './dto/candle-page.dto';
import { MarketCandlesQueryDto } from './dto/market-candles-query.dto';
import { MarketDataService } from './market-data.service';

/**
 * MODULE 06b - historical market data over HTTP.
 *
 * ONE READ ROUTE. `GET /api/market/candles` is the whole surface, and there is
 * no second one for "the symbols available": that list is three entries long,
 * would be a second route to secure and test, and a client that knows it is
 * asking for `BTCUSDT` already knows it wants candles.
 *
 * AUTHENTICATED, LIKE EVERYTHING ELSE. The global guard from Module 02 is
 * default-deny and nothing here opts out with `@Public()`. Public market data is
 * still a signed-in read in this application, because who is asking is the input
 * to whatever a later module decides to let them do with it - the same reasoning
 * Module 05 applies to browsing the strategy catalogue.
 *
 * READ-ONLY. No body, no path parameter beyond the query string, and nothing to
 * mutate: the history behind this route comes from committed files read by an
 * offline seed. An import endpoint would mean an HTTP request that walks the
 * filesystem, a job to serialise and a set of failure modes to authenticate,
 * for an operation that happens once per dataset.
 *
 * ERROR SHAPES ARE EXACT. 400 for a malformed window (`from` after `to`, a
 * symbol that is not alphanumeric, a page below 1), 404 only for a symbol that
 * does not exist, 401 for no token. An empty window for a symbol that *does*
 * exist is a 200 with `total: 0`, because "no bars in March" answers the
 * question that was asked.
 */
@ApiTags('market')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('market')
export class MarketDataController {
  constructor(private readonly marketDataService: MarketDataService) {}

  @Get('candles')
  @ApiOperation({
    summary: 'Read historical daily candles',
    description:
      'Daily OHLCV bars imported from Binance Spot, ascending by day. Symbol is case-insensitive. ' +
      '`from` and `to` are inclusive UTC calendar days. Money fields are exact decimal strings, ' +
      'never JSON numbers. An empty window for a known symbol is a 200 with total 0; an unknown ' +
      'symbol is a 404. Requires authentication.',
  })
  @ApiOkResponse({ type: CandlePageDto })
  @ApiBadRequestResponse({ description: 'The window or a parameter is malformed.' })
  @ApiNotFoundResponse({ description: 'No such symbol.' })
  async candles(@Query() query: MarketCandlesQueryDto): Promise<CandlePageDto> {
    return this.marketDataService.listCandles(query);
  }
}
