import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BarsQueryDto } from './dto/bars-query.dto';
import { BarsDto } from './dto/bars.dto';
import { FeedStatusDto } from './dto/feed-status.dto';
import { InstrumentDto } from './dto/instrument.dto';
import { QuoteDto } from './dto/quote.dto';
import { QuotesQueryDto } from './dto/quotes-query.dto';
import { LiveDataService } from './live-data.service';

/**
 * MODULE 06c - live market data over HTTP.
 *
 * FOUR ROUTES, ALL AUTHENTICATED, ALL READ-ONLY. The global guard from Module
 * 02 is default-deny and nothing here opts out with `@Public()`: even an
 * instrument list is a signed-in read, because who is asking is the input to
 * whatever a later module decides to let them do with a live price. There is no
 * write route and no websocket - a live screen polls with `cache: no-store`,
 * the same transport every other screen in this application uses.
 *
 * `symbol` is carried in query parameters, not path parameters. The catalogue
 * contains `BTC/USD`, a slash in a path segment is a proxy-encoding footgun
 * and would require inconsistent decoding at the edge; a query parameter avoids
 * that entirely while still producing 404s for symbols that are not in the
 * closed catalogue.
 */
@ApiTags('market-data')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('market-data')
export class LiveDataController {
  constructor(private readonly liveDataService: LiveDataService) {}

  @Get('instruments')
  @ApiOperation({
    summary: 'The live-market instrument catalogue',
    description:
      'The closed, code-defined universe of instruments this module offers: five US equities and three USD crypto pairs. ' +
      'A symbol outside this list cannot be quoted, charted or paper-traded - the module rejects it before any provider is consulted.',
  })
  @ApiOkResponse({ type: [InstrumentDto] })
  instruments(): InstrumentDto[] {
    return this.liveDataService.instruments();
  }

  @Get('status')
  @ApiOperation({
    summary: 'Live feed status',
    description:
      'Which provider is configured and whether it can produce real observations. Cheap enough to poll; ' +
      'a screen uses it to decide whether to label itself LIVE, DEMO or DISABLED before drawing a single price.',
  })
  @ApiOkResponse({ type: FeedStatusDto })
  status(): FeedStatusDto {
    return this.liveDataService.status();
  }

  @Get('quotes')
  @ApiOperation({
    summary: 'The latest quote for one instrument',
    description:
      'A 200 with available=false (and null prices) for any known symbol whose feed said nothing just now. ' +
      'A symbol that is not in the catalogue is a 404. stale=true means the observation is older than the instrument freshness threshold.',
  })
  @ApiOkResponse({ type: QuoteDto })
  @ApiNotFoundResponse({ description: 'The symbol is not part of the live-market universe.' })
  async quote(
    @CurrentUser() _user: AuthContext,
    @Query() query: QuotesQueryDto,
  ): Promise<QuoteDto> {
    return this.liveDataService.quote(query.symbol, new Date());
  }

  @Get('bars')
  @ApiOperation({
    summary: 'Recent bars for one instrument',
    description:
      'Bars for a single instrument, ascending by time, limited to 200. Returns 503 with the SERVICE_UNAVAILABLE code when the live feed is disabled ' +
      '(MARKET_DATA_PROVIDER=off); an enabled feed answering with no bars is a 200 with an empty items list.',
  })
  @ApiOkResponse({ type: BarsDto })
  @ApiBadRequestResponse({ description: 'timeframe or limit is out of the documented range.' })
  @ApiNotFoundResponse({ description: 'The symbol is not part of the live-market universe.' })
  @ApiServiceUnavailableResponse({ description: 'The live feed is disabled (MARKET_DATA_PROVIDER=off).' })
  async bars(
    @CurrentUser() _user: AuthContext,
    @Query() query: BarsQueryDto,
  ): Promise<BarsDto> {
    return this.liveDataService.bars(query.symbol, query.timeframe ?? '1m', query.limit ?? 60, new Date());
  }
}