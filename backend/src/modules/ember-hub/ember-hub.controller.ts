import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
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
import { PurchaseEmberRequestDto } from './dto/purchase-ember-request.dto';
import {
  CreatePurchaseResponseDto,
  EmberPurchaseListResponseDto,
  EmberPurchaseResponseDto,
} from './dto/ember-purchase-response.dto';
import { EmberHubScenariosResponseDto, EmberHubStatementDto } from './dto/ember-hub-overview.dto';
import { EmberHubService } from './ember-hub.service';

/**
 * EMBER Hub routes: the configured distribution price, purchase scenarios
 * (display-only), purchases and purchase history.
 *
 * Every authenticated caller may purchase - buying EMBER inventory is not a
 * privileged operation. RBAC is deliberately NOT applied here (only the
 * admin tokenomics/blockchain write routes are PLATFORM_ADMIN-gated), and
 * no user id is ever accepted as input: the caller is the buyer.
 */
@ApiTags('ember-hub')
@ApiBearerAuth()
@Controller('ember-hub')
export class EmberHubController {
  constructor(private readonly emberHubService: EmberHubService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'The hub terms: configured price, limits, display rate, inventory',
    description:
      'Returns the configured distribution price (INR per EMBER), the per-user daily/monthly EMBER limits, the display-only USDT/INR conversion rate (null when unset) and the treasury EMBER inventory actually available. The note explains that prices and limits are configuration, not market observations, and that purchases are internal transfers that do not change on-chain supply.',
  })
  @ApiOkResponse({ type: EmberHubStatementDto })
  async overview(): Promise<EmberHubStatementDto> {
    return EmberHubStatementDto.from(await this.emberHubService.statement());
  }

  @Get('scenarios')
  @ApiOperation({
    summary: 'Illustrative purchase scenarios with computed costs (display-only)',
    description:
      'Three named illustrative quantities priced at the configured rate. Nothing here touches the ledger - a scenario is a read-only cost preview.',
  })
  @ApiOkResponse({ type: EmberHubScenariosResponseDto })
  async scenarios(): Promise<EmberHubScenariosResponseDto> {
    return EmberHubScenariosResponseDto.from(await this.emberHubService.scenarios());
  }

  @Post('purchases')
  @ApiOperation({
    summary: 'Buy EMBER from the hub at the configured price',
    description:
      'One atomic transaction moves treasury EMBER to the caller and the caller\'s USDT (at the display-only conversion rate) to the treasury, together with the purchase row. Limits: the amounts a caller may buy per UTC day and month are enforced from completed purchases. Idempotent on (caller, clientRequestId): a replay returns the original purchase (200). Domain refusals (insufficient balance, limits, empty treasury inventory) move nothing and leave the key reusable; a non-domain failure mid-transaction writes a FAILED audit row outside the rolled-back transaction and a replay of that key is then refused with 409.',
  })
  @ApiCreatedResponse({ type: CreatePurchaseResponseDto, description: 'Purchase committed.' })
  @ApiOkResponse({ type: CreatePurchaseResponseDto, description: 'Idempotent replay of the original purchase.' })
  async purchase(
    @CurrentUser() user: AuthContext,
    @Body() dto: PurchaseEmberRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatePurchaseResponseDto> {
    const { purchase, created } = await this.emberHubService.purchase(user.id, dto);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return CreatePurchaseResponseDto.from({ purchase, created });
  }

  @Get('purchases')
  @ApiOperation({
    summary: 'The caller\'s own purchase history, newest first',
    description: 'The 50 most recent completed purchases of this caller. Ownership is by the caller id - an anonymous user sees an empty list.',
  })
  @ApiOkResponse({ type: EmberPurchaseListResponseDto })
  async myPurchases(
    @CurrentUser() user: AuthContext,
    @Query('limit') limitQuery?: string,
  ): Promise<EmberPurchaseListResponseDto> {
    const parsed = Number.parseInt(limitQuery ?? '', 10);
    const limit = Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 50;
    const rows = await this.emberHubService.purchasesFor(user.id, limit);
    return EmberPurchaseListResponseDto.from(rows);
  }
}
