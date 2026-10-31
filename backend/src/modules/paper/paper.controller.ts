import { Controller, Get, Param, ParseUUIDPipe, Post, Body } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Prisma } from '@prisma/client';
import type { PaperOrder } from '@prisma/client';
import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { StrategyService } from '../strategy/strategy.service';
import { PlacePaperOrderDto } from './dto/place-paper-order.dto';
import { PaperAccountResponseDto, PaperPositionResponseDto, PaperSummaryResponseDto } from './dto/paper-account-response.dto';
import { PaperOrderResponseDto } from './dto/paper-order-response.dto';
import { PaperExecutionService } from './execution.service';
import { PaperService } from './paper.service';

/**
 * MODULE 06c - paper trading over HTTP.
 *
 * THE POST RETURNS 201 IN BOTH CASES. A fill produces status FILLED; a refused
 * request produces status REJECTED with a rejectReason and the row is persisted.
 * Only "strategy not visible/not owned", "unknown symbol" or routing errors map
 * to 4xx/5xx; the decision outcome is a committed order row returned 201.
 *
 * OWNER-ONLY WITHOUT EXCEPTION. Every route resolves the strategy through
 * `StrategyService.findOwned` before reading a single row. A strategy that
 * exists but belongs to somebody else is a 404 here, never a 403 that confirms
 * the id was real.
 */
@ApiTags('strategies')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'No token, or a token that is not an ACTIVE user.' })
@Controller('strategies/:strategyId/paper')
export class PaperController {
  constructor(
    private readonly paperExecutionService: PaperExecutionService,
    private readonly paperService: PaperService,
    private readonly strategyService: StrategyService,
  ) {}

  @Post('orders')
  @ApiOperation({
    summary: 'Place a market order on a paper strategy',
    description: 'Market order, long-only. Returns 201 with FILLED or REJECTED. Idempotent on (strategyId, clientRequestId).',
  })
  @ApiCreatedResponse({ type: PaperOrderResponseDto })
  @ApiBadRequestResponse({ description: 'Unknown symbol, zero quantity or invalid request.' })
  @ApiNotFoundResponse({ description: 'Strategy not found or not owned.' })
  async placeOrder(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Body() body: PlacePaperOrderDto,
  ): Promise<PaperOrderResponseDto> {
    const order = await this.paperExecutionService.execute({
      viewerId: user.id,
      strategyId,
      clientRequestId: body.clientRequestId,
      symbol: body.symbol,
      side: body.side,
      quantity: new Prisma.Decimal(body.quantity),
    });
    return PaperOrderResponseDto.from(order);
  }

  @Get('orders')
  @ApiOperation({ summary: 'List recent paper orders for a strategy', description: 'Most recent first, owner-only.' })
  @ApiOkResponse({ type: [PaperOrderResponseDto] })
  @ApiNotFoundResponse({ description: 'Strategy not found or not owned.' })
  async orders(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<PaperOrderResponseDto[]> {
    await this.owned(user, strategyId);
    const orders = await this.paperService.getOrders(strategyId);
    return orders.map((o: PaperOrder) => PaperOrderResponseDto.from(o));
  }

  @Get('account')
  @ApiOperation({
    summary: 'Paper cash account and open positions for a strategy',
    description:
      'Owner-only. `account` is null until the first order provisions the paper account; `positions` is empty for a strategy that has never held one. ' +
      'Realized P&L is the ledger figure for closed SELLs only - no unrealised mark is invented here.',
  })
  @ApiOkResponse({ type: PaperSummaryResponseDto })
  @ApiNotFoundResponse({ description: 'Strategy not found or not owned.' })
  async account(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<PaperSummaryResponseDto> {
    await this.owned(user, strategyId);
    const [account, positions] = await Promise.all([
      this.paperService.getAccount(strategyId),
      this.paperService.getPositions(strategyId),
    ]);

    return {
      account: account ? PaperAccountResponseDto.from(account) : null,
      positions: positions.map((p) => PaperPositionResponseDto.from(p)),
    };
  }

  /** Resolves ownership so a read can never cross a strategy boundary. */
  private async owned(user: AuthContext, strategyId: string): Promise<void> {
    await this.strategyService.findOwned(user.id, strategyId);
  }
}
