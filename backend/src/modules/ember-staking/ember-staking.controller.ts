import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { Role } from '@prisma/client';
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
import { Roles } from '../rbac/roles.decorator';
import { StakeEmberRequestDto } from './dto/stake-ember-request.dto';
import {
  CreateStakeResponseDto,
  EmberStakingConfigResponseDto,
  EmberStakePositionResponseDto,
  EmberStakePositionsResponseDto,
} from './dto/ember-stake-position-response.dto';
import { EmberStakingService } from './ember-staking.service';

/**
 * EMBER staking routes.
 *
 * Owned data only: every position read or written is scoped to the caller
 * (`@CurrentUser`), and someone else's id answers 404 so ids cannot be
 * probed. The stake/unstake mutations are LIQUIDITY_PROVIDER and
 * PLATFORM_ADMIN-gated per the owner-approved decision: locking real EMBER
 * inventory into the simulated program is a provider-side operation, while
 * reading one's own positions needs nothing more than authentication.
 */
@ApiTags('ember-staking')
@ApiBearerAuth()
@Controller('ember-staking')
export class EmberStakingController {
  constructor(private readonly emberStakingService: EmberStakingService) {}

  @Post('stakes')
  @Roles(Role.LIQUIDITY_PROVIDER, Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Open a simulated stake position (real wallet lock)',
    description:
      'Locks the given EMBER from the caller\'s wallet available balance into the position (a LOCK ledger leg) with the configured lock duration. The REWARDS this module shows are simulation-only at the configured APR, computed at read time, never credited and never minted - the response labels them simulated. Idempotent on (caller, clientRequestId): a replay returns the original position (200).',
  })
  @ApiCreatedResponse({ type: CreateStakeResponseDto, description: 'Position opened and locked.' })
  @ApiOkResponse({ type: CreateStakeResponseDto, description: 'Idempotent replay of the original position.' })
  async stake(
    @CurrentUser() user: AuthContext,
    @Body() dto: StakeEmberRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateStakeResponseDto> {
    const { position, created } = await this.emberStakingService.stake(user.id, dto);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return CreateStakeResponseDto.from({
      position,
      created,
      simulation: await this.emberStakingService.simulationFor(position),
    });
  }

  @Post('stakes/:stakeId/unstake')
  @Roles(Role.LIQUIDITY_PROVIDER, Role.PLATFORM_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End a stake position after its lock has expired',
    description:
      'Unlocks the position\'s EMBER back into available (an UNLOCK ledger leg) and marks the position UNSTAKED, exactly once - an already-unstaked position replays 200 without touching balances again. Unstaking before the lock has expired is refused (409) rather than penalized.',
  })
  @ApiCreatedResponse({ type: CreateStakeResponseDto, description: 'Position unlocked.' })
  @ApiOkResponse({ type: CreateStakeResponseDto, description: 'The position was already unstaked (replay).' })
  async unstake(
    @CurrentUser() user: AuthContext,
    @Param('stakeId', ParseUUIDPipe) stakeId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateStakeResponseDto> {
    const { position, created } = await this.emberStakingService.unstake(user.id, stakeId);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return CreateStakeResponseDto.from({
      position,
      created,
      simulation: await this.emberStakingService.simulationFor(position),
    });
  }

  @Get('config')
  @ApiOperation({
    summary: 'Configured lock period and APR of the staking program',
    description:
      'The one lock duration and APR a stake is actually opened with (deployment configuration). The UI reads this so a page that shows several lock periods can mark the configured one as the real choice. Requires only authentication; reads no user data.',
  })
  @ApiOkResponse({ type: EmberStakingConfigResponseDto })
  config(): EmberStakingConfigResponseDto {
    const { aprPercent, lockDays } = this.emberStakingService.programConfig();
    const dto = new EmberStakingConfigResponseDto();
    dto.aprPercent = aprPercent;
    dto.lockDays = lockDays;
    return dto;
  }

  @Get('positions')
  @ApiOperation({
    summary: 'The caller\'s own stake positions with simulated rewards',
    description:
      'Every position of the caller, newest first. Rewards are computed at read time (amount x configured APR x elapsed days / 365): display-only figures that are never stored, credited or minted. Requires only authentication.',
  })
  @ApiOkResponse({ type: EmberStakePositionsResponseDto })
  async positions(
    @CurrentUser() user: AuthContext,
    @Query('limit') limitQuery?: string,
  ): Promise<EmberStakePositionsResponseDto> {
    const parsed = Number.parseInt(limitQuery ?? '', 10);
    const limit = Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 50;
    const rows = await this.emberStakingService.positionsFor(user.id, limit);
    return EmberStakePositionsResponseDto.from(rows);
  }
}
