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
import { WalletService } from '../wallet/wallet.service';
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
 * Only "strategy not visible/not owned", "unknown symbol", "nothing to close"
 * or routing errors map to 4xx/5xx; the decision outcome is a committed order
 * row returned 201.
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
    private readonly walletService: WalletService,
  ) {}

  @Post('orders')
  @ApiOperation({
    summary: 'Place a market order on a paper strategy',
    description:
      'Market order, LONG or SHORT. Returns 201 with FILLED or REJECTED. Idempotent on (strategyId, clientRequestId). ' +
      "The trader's real USDT balance must cover the order's notional, or the order is recorded as refused.",
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

  @Post('positions/:symbol/close')
  @ApiOperation({
    summary: 'Close an open paper position at the live market price',
    description:
      'The position is closed by an ordinary order in the opposite direction, at the position\'s own quantity, ' +
      'under the same price and wallet rules as any other order. 404 when the strategy holds no position for that symbol.',
  })
  @ApiCreatedResponse({ type: PaperOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Strategy not found or not owned, or no open position for the symbol.' })
  async closePosition(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
    @Param('symbol') symbol: string,
  ): Promise<PaperOrderResponseDto> {
    const order = await this.paperExecutionService.closePosition(user.id, strategyId, symbol);
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
    summary: 'Paper cash account, open positions marked at the market, and the wallet USDT balance',
    description:
      'Owner-only. `account` is null until the first order provisions the paper account; `positions` is empty for a strategy that has never held one. ' +
      'Each position carries its direction, the mark it was priced at, its market value and its unrealised P&L - null when the feed produced no price. ' +
      '`walletUsdt` is the trader\'s real USDT balance, which every order\'s notional has to be covered by.',
  })
  @ApiOkResponse({ type: PaperSummaryResponseDto })
  @ApiNotFoundResponse({ description: 'Strategy not found or not owned.' })
  async account(
    @CurrentUser() user: AuthContext,
    @Param('strategyId', new ParseUUIDPipe()) strategyId: string,
  ): Promise<PaperSummaryResponseDto> {
    await this.owned(user, strategyId);
    const [account, positions, walletUsdt] = await Promise.all([
      this.paperService.getAccount(strategyId),
      this.paperService.getMarkedPositions(strategyId),
      this.walletService.getAvailableBalance(user.id, 'USDT'),
    ]);

    return PaperSummaryResponseDto.from({ account, positions, walletUsdt });
  }

  /** Resolves ownership so a read can never cross a strategy boundary. */
  private async owned(user: AuthContext, strategyId: string): Promise<void> {
    await this.strategyService.findOwned(user.id, strategyId);
  }
}
