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
import { BlockchainStatusResponseDto } from './dto/blockchain-status-response.dto';
import {
  EventSyncResponseDto,
  RecoveryResponseDto,
  ReconciliationResponseDto,
} from './dto/blockchain-reporting-response.dto';
import {
  CreateMintResponseDto,
  EmberMintListResponseDto,
  EmberMintRequestResponseDto,
} from './dto/ember-mint-response.dto';
import { CreateMintRequestDto } from './dto/create-mint-request.dto';
import { BlockchainService } from './blockchain.service';

@ApiTags('blockchain')
@ApiBearerAuth()
@Controller('admin/blockchain')
@Roles(Role.PLATFORM_ADMIN)
export class BlockchainController {
  constructor(private readonly blockchainService: BlockchainService) {}

  @Get('status')
  @ApiOperation({
    summary: 'The blockchain layer status (admin only)',
    description:
      'Whether the layer is enabled, the configured network/chain id, token/treasury addresses, signer setups and event-scan range. The RPC reachability probe answers null when the layer is disabled - a disabled layer is a deployment decision, not an outage.',
  })
  @ApiOkResponse({ type: BlockchainStatusResponseDto })
  async status(): Promise<BlockchainStatusResponseDto> {
    return BlockchainStatusResponseDto.from(await this.blockchainService.status());
  }

  @Get('mints')
  @ApiOperation({
    summary: 'Recent mint requests (admin only)',
    description: 'The most recent mint requests in lifecycle order (newest first).',
  })
  @ApiOkResponse({ type: EmberMintListResponseDto })
  async listMints(@Query('limit') limitQuery?: string): Promise<EmberMintListResponseDto> {
    const parsed = Number.parseInt(limitQuery ?? '', 10);
    const limit = Number.isInteger(parsed) && parsed > 0 && parsed <= 100 ? parsed : 25;
    return EmberMintListResponseDto.from(await this.blockchainService.listMints(limit));
  }

  @Post('mints')
  @ApiOperation({
    summary: 'Request a platform mint to the treasury (admin only)',
    description:
      'Amountly checks run first (shape, configured per-mint and monthly budgets), then the transaction is broadcast by the configured minter signer, mined and confirmed: PENDING -> SUBMITTED -> CONFIRMED/FAILED, with contract events ingested from the receipt. The whole request is idempotent on clientRequestId: a replay returns the original request state (200) instead of minting twice. The ledger is never credited by this route - reconciliation is the explicit, authorized bridge.',
  })
  @ApiCreatedResponse({ type: CreateMintResponseDto, description: 'Mint confirmed (or failed after broadcast).' })
  @ApiOkResponse({ type: CreateMintResponseDto, description: 'Idempotent replay of the original request.' })
  async createMint(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateMintRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateMintResponseDto> {
    const { request, created } = await this.blockchainService.createMint(user.id, dto);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return CreateMintResponseDto.from({ request, created });
  }

  @Get('mints/:mintRequestId')
  @ApiOperation({ summary: 'One mint request by id (admin only)' })
  @ApiOkResponse({ type: EmberMintRequestResponseDto })
  async findMint(@Param('mintRequestId', ParseUUIDPipe) mintRequestId: string): Promise<EmberMintRequestResponseDto> {
    return EmberMintRequestResponseDto.from(await this.blockchainService.findRequest(mintRequestId));
  }

  @Post('recovery')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-run receipt checks on open mint requests (admin only)',
    description:
      'SUBMITTED requests whose receipts never got re-checked after a crash or RPC outage are re-polled and confirmed or failed. Requests still waiting on a fresh broadcast are left open - the record is deliberately an honest, inspectable unfinished state, not an inferred one.',
  })
  @ApiOkResponse({ type: RecoveryResponseDto })
  async runRecovery(): Promise<RecoveryResponseDto> {
    return RecoveryResponseDto.from(await this.blockchainService.runRecovery());
  }

  @Post('events/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pull event history from the deployment block (admin only)',
    description:
      'Explicit, pull-based synchronization: reads TokensMinted/TokensBurned logs from BLOCKCHAIN_DEPLOYMENT_BLOCK to latest, ingesting any the dedupe constraint has not already recorded and linking them to their mint/burn records by transaction hash. Re-runs are no-ops by construction; re-scans do not mutate, only fill gaps. Reports scanned/ingested/linked counts.',
  })
  @ApiOkResponse({ type: EventSyncResponseDto })
  async syncEvents(): Promise<EventSyncResponseDto> {
    return EventSyncResponseDto.from(await this.blockchainService.syncEvents());
  }

  @Get('reconciliation')
  @ApiOperation({
    summary: 'The on-chain vs PostgreSQL ledger comparison (admin only)',
    description:
      'Pure comparison: on-chain total supply/treasury balance and event totals against the PostgreSQL ledger issuance/burned/circulating figures, the treasury wallet available EMBER, confirmed mint-request totals and the seed/demo-issuance estimate. Differences are reported, never mutated: they are the evidence an operator or auditor reads before deciding on a correction.',
  })
  @ApiOkResponse({ type: ReconciliationResponseDto })
  async reconciliation(): Promise<ReconciliationResponseDto> {
    return ReconciliationResponseDto.from({ ...await this.blockchainService.reconciliation(), note: 'This comparison reconciles the on-chain token against the PostgreSQL ledger; differences are reported, never mutated.' });
  }
}
