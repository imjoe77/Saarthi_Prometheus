import { Body, Controller, Get, HttpStatus, Post, Res } from '@nestjs/common';
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
import { CreateEmberTransferDto } from './dto/create-ember-transfer.dto';
import { EmberSupplyResponseDto } from './dto/ember-supply-response.dto';
import { EmberTransferResponseDto } from './dto/ember-transfer-response.dto';
import { EmberService } from './ember.service';

/**
 * MODULE 10 — EMBER token accounting.
 *
 * Authenticated like everything else (the global guard from Module 02). There
 * is no `@Public()` route: transfers move the caller's own money and supply
 * figures are harmless but not public by default either.
 *
 * Transfers always name the caller as sender (`@CurrentUser`); there is no
 * route by which one user can spend another's EMBER. The response returns only
 * the transfer id, amount and timestamp - no counterpart user or wallet ids.
 */
@ApiTags('ember')
@ApiBearerAuth()
@Controller('ember')
export class EmberController {
  constructor(private readonly emberService: EmberService) {}

  @Post('transfers')
  @ApiOperation({
    summary: 'Send EMBER to another user by email',
    description:
      'Atomically debits the sender, credits the recipient and records both legs plus one ember_transfers row in a single transaction. Locked EMBER cannot be spent - only the available balance funds a transfer. Idempotent on (sender, clientRequestId): a replay returns the original transfer (200), and reusing the key with a different payload is 409 CONFLICT. Self-transfer is 400; an unknown recipient email is 404.',
  })
  @ApiCreatedResponse({ type: EmberTransferResponseDto, description: 'Transfer created.' })
  @ApiOkResponse({ type: EmberTransferResponseDto, description: 'Idempotent replay of the original transfer.' })
  async transfer(
    @CurrentUser() user: AuthContext,
    @Body() dto: CreateEmberTransferDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EmberTransferResponseDto> {
    const { transfer, created } = await this.emberService.transfer(user.id, dto);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return EmberTransferResponseDto.from(transfer);
  }

  @Get('supply')
  @ApiOperation({
    summary: 'Ledger-derived EMBER supply metrics',
    description:
      'totalIssuedSupply is DEPOSIT credits minus WITHDRAWAL debits across all EMBER wallets; transfers and locks net to zero by construction. burnedSupply sums the BURN ledger legs (one per Module 11 burn record, written in the same transaction); it is zero while no burns are recorded. circulatingSupply is issued minus burned; lockedSupply sums every wallet locked column including Module 09 LP commitment locks; availableSupply is the sum of available columns. Application-level ledger figures, not on-chain supply. No supply table exists; every number is aggregated from the existing accounting records.',
  })
  @ApiOkResponse({ type: EmberSupplyResponseDto })
  async supply(): Promise<EmberSupplyResponseDto> {
    const figures = await this.emberService.supply();
    return EmberSupplyResponseDto.from(figures);
  }
}
