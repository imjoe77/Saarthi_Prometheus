import { Body, Controller, Get, HttpStatus, Param, Post, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';

import type { AuthContext } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../rbac/roles.decorator';
import { LiquidityAllocationDto } from './dto/liquidity-allocation-response.dto';
import { LiquidityCommitmentReduceDto } from './dto/liquidity-commitment-reduce.dto';
import {
  LiquidityCommitmentDto,
  LiquidityProviderDto,
} from './dto/liquidity-commitment-response.dto';
import { LiquidityCommitmentWriteDto } from './dto/liquidity-commitment-write.dto';
import { LiquidityDistributionDto } from './dto/liquidity-distribution-response.dto';
import { LiquiditySlabDto, LiquiditySlabsDto } from './dto/liquidity-slabs-response.dto';
import {
  LiquidityOverviewDto,
  LiquidityTopUpRequestDto,
} from './dto/liquidity-overview-response.dto';
import { LiquidityReductionDto } from './dto/liquidity-reduction-response.dto';
import { LiquidityService } from './liquidity.service';

/**
 * MODULE 09 — simulated liquidity over HTTP.
 *
 * Every mutating route acts on the verified `@CurrentUser`: there is no route
 * by which one LP can create, reduce, or read another's commitment, and the
 * allocations endpoint only ever exposes orders the caller placed. The one
 * cross-provider read is `distribution`, and it answers only to
 * PLATFORM_ADMIN - it reports how USDT is spread across providers without
 * ever moving state.
 *
 * Commitments and reductions answer 503 until EMBER slabs are approved and
 * configured - the service owns that gate. The read routes always work:
 * overview reports aggregate health against the configured threshold (and
 * persists at most one OPEN shortfall notice), top-ups lists those notices,
 * and `commitments/me` shows the caller's own LP state.
 */
@ApiTags('liquidity')
@ApiBearerAuth()
@Controller('liquidity')
export class LiquidityController {
  constructor(private readonly liquidityService: LiquidityService) {}

  @Post('commitments')
  @ApiOperation({
    summary: 'Open or idempotently increase the caller\'s LP commitment (EMBER-gated)',
    description:
      'Auto-registers the caller as an LP and pledges USDT under the flat-cliff EMBER slab requirement - only the lock delta moves, inside the same transaction as the commitment row. Replay of the same clientRequestId returns the original outcome. Refuses 503 until EMBER slabs are approved and configured; a pledge below the lowest slab is 400. 201 on first create, 200 on increase or replay.',
  })
  @ApiCreatedResponse({ description: 'First commitment created for this LP.' })
  @ApiOkResponse({ description: 'Commitment increased, or the request replayed.' })
  async createCommitment(
    @CurrentUser() user: AuthContext,
    @Body() body: LiquidityCommitmentWriteDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ created: boolean; replayed: boolean; commitment: LiquidityCommitmentDto }> {
    const { commitment, created, replayed } = await this.liquidityService.createCommitment(
      user.id,
      body,
    );

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return { created, replayed, commitment: LiquidityCommitmentDto.from(commitment) };
  }

  @Post('commitments/reduce')
  @ApiOperation({
    summary: 'Withdraw USDT from the caller\'s own commitment',
    description:
      'Down to what orders already consumed - consumed liquidity is never withdrawable. The EMBER lock is recomputed against the same approved slabs and only the surplus unlocks; closing to zero releases the lock entirely. Idempotent on (commitmentId, clientRequestId). 503 until slabs are configured. 201 on first application, 200 on replay.',
  })
  @ApiCreatedResponse({ description: 'Reduction applied.' })
  @ApiOkResponse({ description: 'Request replayed; the original reduction.' })
  async reduceCommitment(
    @CurrentUser() user: AuthContext,
    @Body() body: LiquidityCommitmentReduceDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ replayed: boolean; reduction: LiquidityReductionDto }> {
    const { reduction, replayed } = await this.liquidityService.reduceCommitment(user.id, body);

    response.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { replayed, reduction: LiquidityReductionDto.from(reduction) };
  }

  @Get('commitments/me')
  @ApiOperation({
    summary: "The caller's LP registration and commitment",
    description:
      'Both parts are null until the caller first commits. `commitmentsEnabled` reports whether approved EMBER slabs are configured, so disabled-by-configuration is distinguishable from no-commitment-yet.',
  })
  @ApiOkResponse({ description: 'The caller\'s provider row and commitment, when they exist.' })
  async myCommitment(
    @CurrentUser() user: AuthContext,
  ): Promise<{
    provider: LiquidityProviderDto | null;
    commitment: LiquidityCommitmentDto | null;
    commitmentsEnabled: boolean;
  }> {
    const { provider, commitment, commitmentsEnabled } = await this.liquidityService.getMyCommitment(
      user.id,
    );

    return {
      provider: provider ? LiquidityProviderDto.from(provider) : null,
      commitment: commitment ? LiquidityCommitmentDto.from(commitment) : null,
      commitmentsEnabled,
    };
  }

  @Get('slabs')
  @ApiOperation({
    summary: 'The approved EMBER-locking slabs',
    description:
      'The flat-cliff table the server applies when a commitment is opened: a commitment at or above a slab\'s minUsdt locks exactly that slab\'s requiredEmber. Read-only configuration - it moves no money and grants nothing. An empty table means commitment mutations are disabled.',
  })
  @ApiOkResponse({ type: LiquiditySlabsDto })
  slabs(): LiquiditySlabsDto {
    const result = this.liquidityService.getSlabs();

    return {
      commitmentsEnabled: result.commitmentsEnabled,
      slabs: result.slabs.map((slab) => LiquiditySlabDto.from(slab)),
    };
  }

  @Get('overview')
  @ApiOperation({
    summary: 'Aggregate liquidity health against the configured threshold',
    description:
      'Sums usdt_available across ACTIVE commitments of ACTIVE providers, compares with LIQUIDITY_MIN_AVAILABLE_USDT, and persists at most one OPEN shortfall notice: opening one while below the threshold, fulfilling it once liquidity recovers. Detection never moves funds and never selects an LP. Read for numbers, write for the notice - every call is idempotent in effect.',
  })
  @ApiOkResponse({ type: LiquidityOverviewDto })
  async overview(): Promise<LiquidityOverviewDto> {
    const result = await this.liquidityService.getOverview();

    return LiquidityOverviewDto.from(result);
  }

  @Get('topups')
  @ApiOperation({
    summary: 'List liquidity shortfall notices, newest opened first',
    description:
      'OPEN means aggregate liquidity still sits at or below the threshold; FULFILLED means it recovered after the notice opened. Notices are observations, never transactions.',
  })
  @ApiOkResponse({ description: 'Up to the 100 most recent notices.' })
  async topUps(): Promise<{ items: LiquidityTopUpRequestDto[] }> {
    const items = await this.liquidityService.listTopUps();
    return { items: items.map((item) => LiquidityTopUpRequestDto.from(item)) };
  }

  @Get('distribution')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'How USDT is distributed across liquidity providers (admin only)',
    description:
      'Per-provider breakdown for the admin USDT surface: what each LP pledged, what its commitment actually delivered to customer BUY orders (USDT, INR value, slices, distinct orders), how much remains allocatable after every distribution and reduction, each LP\'s share of both the pledge and the remaining pool, and their own USDT wallet - plus pool totals against the configured threshold and the latest allocation slices. Strictly read-only: unlike `overview` it never opens or fulfils a shortfall notice, so an admin refreshing the page moves nothing. 403 for any non-admin caller.',
  })
  @ApiOkResponse({ type: LiquidityDistributionDto })
  async distribution(): Promise<LiquidityDistributionDto> {
    const result = await this.liquidityService.getDistribution();

    return LiquidityDistributionDto.from(result);
  }

  @Get('allocations/:orderId')
  @ApiOperation({
    summary: "The caller's own order's LP allocation slices",
    description:
      'Which commitments funded the BUY order and at what execution price. The caller must own the order - another user\'s id is a 404, never a disclosure. SELL orders and legacy (no-provider) orders return an empty list.',
  })
  @ApiOkResponse({ description: 'Allocation slices, oldest slice first.' })
  async allocations(
    @CurrentUser() user: AuthContext,
    @Param('orderId') orderId: string,
  ): Promise<{ orderId: string; items: LiquidityAllocationDto[] }> {
    const allocations = await this.liquidityService.listAllocations(user.id, orderId);

    return {
      orderId,
      items: allocations.map((allocation) => LiquidityAllocationDto.from(allocation)),
    };
  }
}
