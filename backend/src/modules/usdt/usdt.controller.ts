import { Body, Controller, Get, HttpStatus, Post, Query, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UsdtOrderPageDto } from './dto/usdt-order-page.dto';
import { UsdtOrderQueryDto } from './dto/usdt-order-query.dto';
import { UsdtOrderResponseDto } from './dto/usdt-order-response.dto';
import { UsdtOrderWriteDto } from './dto/usdt-order-write.dto';
import { UsdtQuoteQueryDto } from './dto/usdt-quote-query.dto';
import { UsdtQuoteResponseDto } from './dto/usdt-quote-response.dto';
import { toPricingMetadata } from './dto/usdt-pricing-metadata.dto';
import { UsdtService } from './usdt.service';
import { toLiquidityBlock } from './dto/usdt-order-response.dto';

/**
 * MODULE 08 — the USDT exchange over HTTP.
 *
 * Prototype scope: market-linked pricing with zero Prometheus brokerage, and
 * settlement inside Prometheus's own internal ledger through WalletService —
 * the traded balances and the order row commit atomically together. There is
 * no third-party custody transfer anywhere behind these routes.
 *
 * QUOTE answers with live market data when it is fresh, or with a clearly
 * labelled configured fallback whose savings figure is suppressed; when
 * neither is available it answers 503 PRICING_UNAVAILABLE rather than a price
 * nobody can trust. BUY/SELL settle only on live execution and reference
 * data from the same request - the pricing block on a 201 shows exactly what
 * executed - and never at fallback or stale prices.
 *
 * The caller is always the verified `@CurrentUser`; there is no route by which
 * one user can quote for, place for, or list another user's orders.
 */
@ApiTags('usdt')
@ApiBearerAuth()
@Controller('usdt')
export class UsdtController {
  constructor(private readonly usdtService: UsdtService) {}

  @Get('quote')
  @ApiOperation({
    summary: 'Quote a USDT amount at live market prices (zero brokerage)',
    description:
      'Volume-weighted CoinDCX order-book price for the requested quantity, measured against fresh CoinGecko reference venues. Fallback responses are labelled and carry no savings; unavailable live data answers 503 PRICING_UNAVAILABLE. No wallet or order is touched.',
  })
  @ApiOkResponse({ type: UsdtQuoteResponseDto })
  async quote(@Query() query: UsdtQuoteQueryDto): Promise<UsdtQuoteResponseDto> {
    const result = await this.usdtService.quote(query);
    return UsdtQuoteResponseDto.from(result);
  }

  @Post('buy')
  @ApiOperation({
    summary: 'Buy USDT with INR at the fresh order-book price (zero brokerage)',
    description:
      'Settles at the live ask-side VWAP captured in this request (atomic: INR debit, USDT credit and order row commit together or not at all; 503 PRICING_UNAVAILABLE without fresh pricing). Optional maxExecutionPrice refuses the order if the fresh price moved above it. Idempotent on (user, clientRequestId) - 201 on first acceptance, 200 with the original order on a replay.',
  })
  @ApiCreatedResponse({ type: UsdtOrderResponseDto, description: 'Order accepted and settled; includes the pricing block.' })
  @ApiOkResponse({ type: UsdtOrderResponseDto, description: 'Replayed request; the original order, no balance moved.' })
  async buy(
    @CurrentUser() user: AuthContext,
    @Body() body: UsdtOrderWriteDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UsdtOrderResponseDto> {
    const { order, created, pricing, liquidity } = await this.usdtService.place(user.id, 'BUY', body);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return UsdtOrderResponseDto.from(
      order,
      pricing ? toPricingMetadata(pricing) : undefined,
      created ? toLiquidityBlock(liquidity) : undefined,
    );
  }

  @Post('sell')
  @ApiOperation({
    summary: 'Sell USDT for INR at the fresh order-book price (zero brokerage)',
    description:
      'Atomic and idempotent exactly like BUY: settles at the live bid-side VWAP captured in this request, refuses with 503 without fresh pricing, and honours an optional minExecutionPrice guard.',
  })
  @ApiCreatedResponse({ type: UsdtOrderResponseDto, description: 'Order accepted and settled; includes the pricing block.' })
  @ApiOkResponse({ type: UsdtOrderResponseDto, description: 'Replayed request; the original order, no balance moved.' })
  async sell(
    @CurrentUser() user: AuthContext,
    @Body() body: UsdtOrderWriteDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UsdtOrderResponseDto> {
    const { order, created, pricing } = await this.usdtService.place(user.id, 'SELL', body);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return UsdtOrderResponseDto.from(order, pricing ? toPricingMetadata(pricing) : undefined);
  }

  @Get('orders')
  @ApiOperation({
    summary: "List the caller's USDT order history",
    description:
      'Newest first, keyset-paginated. Pass the returned nextCursor back as ?cursor= for the next page. Rows record the live snapshot prices they settled at; order rows are never written from fallback data.',
  })
  @ApiOkResponse({ type: UsdtOrderPageDto })
  async orders(
    @CurrentUser() user: AuthContext,
    @Query() query: UsdtOrderQueryDto,
  ): Promise<UsdtOrderPageDto> {
    const page = await this.usdtService.getOrdersPage(user.id, query);

    return {
      items: page.items.map((order) => UsdtOrderResponseDto.from(order)),
      nextCursor: page.nextCursor,
    };
  }
}
