import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Post,
  Param,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthContext } from '../auth/auth.service';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../rbac/roles.decorator';
import { CreateAllocationDto } from './dto/create-allocation.dto';
import { CreateBuybackDto } from './dto/create-buyback.dto';
import { CreateBurnDto } from './dto/create-burn.dto';
import { ExecuteBuybackDto } from './dto/execute-buyback.dto';
import { PreviewAllocationDto } from './dto/preview-allocation.dto';
import { TokenAllocationResponseDto } from './dto/token-allocation-response.dto';
import { TokenBuybackResponseDto } from './dto/token-buyback-response.dto';
import { TokenBurnResponseDto } from './dto/token-burn-response.dto';
import { TokenomicsConfigResponseDto } from './dto/tokenomics-config-response.dto';
import { TokenomicsPreviewResponseDto } from './dto/tokenomics-preview-response.dto';
import { TokenomicsRecordsResponseDto } from './dto/tokenomics-records-response.dto';
import { TokenomicsService } from './tokenomics.service';

/**
 * MODULE 11 â€” EMBER tokenomics routes.
 *
 * Authenticated like everything else (the global guard from Module 02): there
 * is no `@Public()` route. Records are created by and listed for the caller
 * (`@CurrentUser`), and an id belonging to somebody else answers 404 rather
 * than 403 so ids cannot be probed - the Module 05 posture. No RBAC exists in
 * the codebase, so "who may record" is deliberately not invented here: any
 * authenticated caller may, and the treasury every burn debits is a system
 * wallet, not a caller.
 *
 * Creation routes answer 201 when a record was written and 200 on an
 * idempotent replay, matching Modules 08-10. `POST /preview` always answers
 * 200: it computes and writes nothing, because only burns change supply.
 */
@ApiTags('tokenomics')
@ApiBearerAuth()
@Controller('tokenomics')
export class TokenomicsController {
  constructor(private readonly tokenomicsService: TokenomicsService) {}

  @Get('config')
  @ApiOperation({
    summary: 'The configured direct-burn / buyback allocation split',
    description:
      'The split as resolved at boot from TOKENOMICS_DIRECT_BURN_PCT and TOKENOMICS_BUYBACK_PCT (defaults 60/40). The backend refuses to start unless the two sum to 100, so this pair always does.',
  })
  @ApiOkResponse({ type: TokenomicsConfigResponseDto })
  config(): TokenomicsConfigResponseDto {
    return TokenomicsConfigResponseDto.from(this.tokenomicsService.configSummary());
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compute an allocation without recording it',
    description:
      'Splits the reference amount by the configured percentages (the adaptive treasury-health policy when the module wires it, the configured baseline otherwise) and derives EMBER quantities at the supplied illustrative price, through the exact arithmetic POST /allocations records. Validates inputs the same way (positive, INR 2dp, valid price) and refuses invalid ones with 400. Writes nothing: no record, no balance movement, no supply change - a preview is always illustrative and must be labelled as such by the client.',
  })
  @ApiOkResponse({ type: TokenomicsPreviewResponseDto })
  async preview(@Body() dto: PreviewAllocationDto): Promise<TokenomicsPreviewResponseDto> {
    return TokenomicsPreviewResponseDto.from(await this.tokenomicsService.preview(dto));
  }

  @Post('allocations')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Record an allocation proposal (simulated)',
    description:
      'Splits referenceAmount across the configured percentages: the direct-burn portion rounds HALF_UP to INR 2dp, the buyback portion is the exact remainder (so the two always sum to referenceAmount), and both EMBER quantities are floored to 18dp at emberPrice. A reference-price metric, never cash or funding. Moves nothing and changes no supply figure. Idempotent on (caller, clientRequestId): a replay returns the original record (200); the same key with a different amount or price is 409 CONFLICT. Zero/negative values and amounts beyond INR 2dp are 400.',
  })
  @ApiCreatedResponse({ type: TokenAllocationResponseDto, description: 'Allocation recorded.' })
  @ApiOkResponse({ type: TokenAllocationResponseDto, description: 'Idempotent replay of the original allocation.' })
  async createAllocation(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateAllocationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TokenAllocationResponseDto> {
    const { allocation, created } = await this.tokenomicsService.createAllocation(user.id, dto);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return TokenAllocationResponseDto.from(allocation);
  }

  @Post('buybacks')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Record a simulated buyback against an allocation (simulated)',
    description:
      'Proposes the buyback of an allocationâ€™s buyback portion and moves nothing - no balances, no supply. One buyback per allocation (database-enforced), so the same proposal cannot be bought back twice. Idempotent on (caller, clientRequestId): a replay returns the original record (200), a reused key naming another allocation is 409, and losing the race for an allocation that already has a buyback is 409. An unknown or not-yours allocation is 404.',
  })
  @ApiCreatedResponse({ type: TokenBuybackResponseDto, description: 'Simulated buyback recorded (status SIMULATED).' })
  @ApiOkResponse({ type: TokenBuybackResponseDto, description: 'Idempotent replay of the original buyback.' })
  async createBuyback(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateBuybackDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TokenBuybackResponseDto> {
    const { buyback, created } = await this.tokenomicsService.createBuyback(user.id, dto);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return TokenBuybackResponseDto.from(buyback);
  }

  @Post('buybacks/:buybackId/execute')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Record a simulated execution against a buyback (still simulated)',
    description:
      'Transitions the buyback SIMULATED -> RECORDED_SIMULATED_EXECUTION and stores the executed price plus the executed quantity (the buyback portion divided by that price, floored to 18dp). It still moves no balances and funds nothing: the architecture has no price venue, buyback funding or settlement, so no state here can claim an actual execution. One-way and guarded: a replay of the same price returns the record (200), a different price for a recorded execution is 409, and racing executions resolve to exactly one winner. A price at which the quantity would floor to zero is 400.',
  })
  @ApiCreatedResponse({ type: TokenBuybackResponseDto, description: 'Simulated execution recorded.' })
  @ApiOkResponse({ type: TokenBuybackResponseDto, description: 'Replay of the already-recorded execution (same price).' })
  async executeBuyback(
    @CurrentUser() user: AuthContext,
    @Param('buybackId', ParseUUIDPipe) buybackId: string,
    @Body() dto: ExecuteBuybackDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TokenBuybackResponseDto> {
    const { buyback, created } = await this.tokenomicsService.executeBuyback(
      user.id,
      buybackId,
      dto,
    );

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return TokenBuybackResponseDto.from(buyback);
  }

  @Post('burns')
  @Roles(Role.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Record a burn: the one operation that destroys EMBER',
    description:
      'Debits the treasury walletâ€™s available EMBER with a BURN ledger leg and inserts the burn record in one transaction, so a record exists if and only if the destruction committed - supplyâ€™s burnedSupply (Module 10, SUM of BURN legs) then counts it exactly once. DIRECT requires amount and forbids buybackId; BUYBACK requires an owned, executed buyback and forbids amount (the executed quantity is burned exactly). Only one burn can reference a buyback (database-enforced). Locked EMBER cannot fund a burn; an unfunded treasury is 409 INSUFFICIENT_BALANCE and writes nothing. Idempotent on (caller, clientRequestId): replay 200, changed payload 409.',
  })
  @ApiCreatedResponse({ type: TokenBurnResponseDto, description: 'Burn recorded and applied to the ledger.' })
  @ApiOkResponse({ type: TokenBurnResponseDto, description: 'Idempotent replay of the original burn.' })
  async createBurn(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateBurnDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TokenBurnResponseDto> {
    const { burn, created } = await this.tokenomicsService.createBurn(user.id, dto);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return TokenBurnResponseDto.from(burn);
  }

  @Get('records')
  @ApiOperation({
    summary: "The caller's own tokenomics records, newest first",
    description:
      'Allocations, simulated buybacks and burns recorded by the caller, each list bounded to the 50 most recent entries. Per-caller like every other listing: there is no admin role through which one user could read anotherâ€™s records. Global supply figures come from GET /ember/supply instead - the two reconcile because every burn listed here corresponds to exactly one BURN ledger leg.',
  })
  @ApiOkResponse({ type: TokenomicsRecordsResponseDto })
  async records(@CurrentUser() user: AuthContext): Promise<TokenomicsRecordsResponseDto> {
    return TokenomicsRecordsResponseDto.from(await this.tokenomicsService.records(user.id));
  }
}
