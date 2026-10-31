import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SimulationPageQueryDto } from './dto/simulation-page-query.dto';
import { SimulationBalancePageDto, SimulationFillPageDto } from './dto/simulation-page.dto';
import { SimulationResponseDto } from './dto/simulation-response.dto';
import { SimulationService } from './simulation.service';

/**
 * MODULE 06b - simulations over HTTP.
 *
 * THREE READ ROUTES, NO WRITE ROUTE. `GET /simulations/:strategyId` with two
 * optional sub-lists (`/fills`, `/balance`) is the whole surface. A route that
 * *ran* a simulation is absent on purpose: a caller-triggered computation would
 * be inventing a curve the seed has no part in, against data the directory owns,
 * for a result nobody asked a question about. Re-running belongs to the seed,
 * where the rule, the candles and the fee assumption are all visible together.
 *
 * AUTHENTICATED, LIKE EVERYTHING ELSE, AND VISIBILITY IS THE CONTRACT. The
 * global guard from Module 02 is default-deny and nothing opts out with
 * `@Public()`. Every handler resolves the strategy through the strategy module's
 * visibility rule first - a simulation is evidence about a strategy, so the
 * evidence must not be reachable through a second door - and a strategy the
 * caller may not see is reported as not found rather than as forbidden.
 *
 * THE FLAGS DO NOT LIVE HERE, THEY ARE IMPORTED. `simulated` and
 * `notRealTrades` are part of `SimulationResponseDto` and always true, because
 * the shape of the answer is exactly the point of the module: no display of a
 * curve is complete without the sentence that says it is a curve.
 */
@ApiTags('simulations')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('simulations')
export class SimulationController {
  constructor(private readonly simulationService: SimulationService) {}

  @Get(':strategyId')
  @ApiOperation({
    summary: 'Read a strategy\u2019s simulation summary',
    description:
      'The provenance and shape of the strategy\u2019s simulated curve: rule, symbol, window, ' +
      'starting cash, fee assumption and row counts. Always includes `simulated: true` and ' +
      '`notRealTrades: true`. A visible strategy that was never simulated is a 404, and ' +
      'a strategy the caller may not see is a 404 too. Requires authentication.',
  })
  @ApiOkResponse({ type: SimulationResponseDto })
  @ApiBadRequestResponse({ description: 'The strategy id is not a UUID.' })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one the caller may see, or never simulated.' })
  async summary(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<SimulationResponseDto> {
    return this.simulationService.summary(user.id, strategyId);
  }

  @Get(':strategyId/fills')
  @ApiOperation({
    summary: 'Read the fills of a simulation',
    description:
      'Every simulated order, ascending by sequence: when it filled, at which open, for how ' +
      'much, and what the paper cash was afterwards. The fee rate they were charged at is on ' +
      'the simulation summary. Requires authentication.',
  })
  @ApiOkResponse({ type: SimulationFillPageDto })
  @ApiBadRequestResponse({ description: 'The strategy id is not a UUID, or the paging parameters are invalid.' })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one the caller may see, or never simulated.' })
  async fills(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Query() query: SimulationPageQueryDto,
  ): Promise<SimulationFillPageDto> {
    return this.simulationService.fills(user.id, strategyId, query.page, query.limit);
  }

  @Get(':strategyId/balance')
  @ApiOperation({
    summary: 'Read the daily balance curve of a simulation',
    description:
      'One row per UTC day across the whole window: paper cash, position quantity, position ' +
      'value at that day\u2019s close, and their sum - the series the Risk Engine measures. ' +
      'Requires authentication.',
  })
  @ApiOkResponse({ type: SimulationBalancePageDto })
  @ApiBadRequestResponse({ description: 'The strategy id is not a UUID, or the paging parameters are invalid.' })
  @ApiNotFoundResponse({ description: 'No such strategy, or not one the caller may see, or never simulated.' })
  async balances(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Query() query: SimulationPageQueryDto,
  ): Promise<SimulationBalancePageDto> {
    return this.simulationService.balances(user.id, strategyId, query.page, query.limit);
  }
}