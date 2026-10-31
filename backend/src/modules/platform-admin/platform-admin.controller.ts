import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthContext } from '../auth/auth.service';
import { Roles } from '../rbac/roles.decorator';
import {
  AssetStatusRequestDto,
  UserStatusRequestDto,
  WalletMovementRequestDto,
  WalletStatusRequestDto,
  TreasuryFundingRequestDto,
  TreasuryWithdrawalRequestDto,
} from './dto/platform-admin.dto';
import {
  PlatformAdminService,
  AssetStatusResult,
  MovementResult,
  PlatformOverview,
  PlatformUserDetail,
  StatusResult,
  WalletStatusResult,
} from './platform-admin.service';

/**
 * PLATFORM ADMIN - the money and account controls of the platform.
 *
 * This controller exists so the admin console can do what console READMEs
 * promise: add capital and EMBER to the platform of record (the treasury
 * wallet), remove capital the same way, correct or debit any user's wallet,
 * retire or restore an asset, read the whole platform as one snapshot, and
 * stop an account or its wallet when the platform must. Every route carries
 * `@Roles(PLATFORM_ADMIN)` (enforced server-side by the global RolesGuard)
 * and every underlying action writes an admin audit row in the same
 * transaction as its effect.
 *
 * Note what stays out of reach: PLATFORM_ADMIN cannot be granted here (or
 * anywhere over HTTP - that remains the operator CLI), balance movements are
 * always explanations-first (a note is required on every adjustment), and the
 * reads are read-only - no snapshot here can be mistaken for a mutation.
 */
@ApiTags('platform admin')
@ApiBearerAuth()
@Roles(Role.PLATFORM_ADMIN)
@Controller('admin/platform')
export class PlatformAdminController {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'One read-only snapshot of the whole platform for the admin console' })
  @ApiOkResponse({ description: 'Counters, role distribution, per-asset aggregates, treasury state and the latest audit rows.' })
  platformOverview(): Promise<PlatformOverview> {
    return this.platformAdmin.platformOverview();
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Everything the platform knows about one account (roles, wallet, ledger tail)' })
  @ApiOkResponse({ description: 'The account detail; `wallet` is null when the account has no wallet.' })
  userDetail(
    @Param('id', ParseUUIDPipe) targetUserId: string,
  ): Promise<PlatformUserDetail> {
    return this.platformAdmin.userDetail(targetUserId);
  }

  @Post('treasury/funding')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Credit the treasury wallet (capital / EMBER inventory top-up)' })
  @ApiOkResponse({ description: 'The treasury balance after the funding credit.' })
  fundTreasury(
    @CurrentUser() admin: AuthContext,
    @Body() dto: TreasuryFundingRequestDto,
  ): Promise<MovementResult> {
    return this.platformAdmin.fundTreasury(admin.id, dto);
  }

  @Post('treasury/withdrawal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Debit the treasury wallet (remove capital / retire inventory)' })
  @ApiOkResponse({ description: 'The treasury balance after the withdrawal debit.' })
  withdrawFromTreasury(
    @CurrentUser() admin: AuthContext,
    @Body() dto: TreasuryWithdrawalRequestDto,
  ): Promise<MovementResult> {
    return this.platformAdmin.withdrawFromTreasury(admin.id, dto);
  }

  @Post('assets/:symbol/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retire or restore an asset for new movements (note required)' })
  @ApiOkResponse({ description: 'The asset lifecycle flag after the change.' })
  setAssetActive(
    @CurrentUser() admin: AuthContext,
    @Param('symbol') symbol: string,
    @Body() dto: AssetStatusRequestDto,
  ): Promise<AssetStatusResult> {
    return this.platformAdmin.setAssetActive(admin.id, symbol, dto);
  }

  @Post('users/:id/wallet-movements')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Credit or debit a user wallet by hand (ADJUSTMENT, note required)' })
  @ApiOkResponse({ description: 'The wallet balance after the adjustment.' })
  moveWallet(
    @CurrentUser() admin: AuthContext,
    @Param('id', ParseUUIDPipe) targetUserId: string,
    @Body() dto: WalletMovementRequestDto,
  ): Promise<MovementResult> {
    return this.platformAdmin.moveWallet(admin.id, targetUserId, dto);
  }

  @Post('users/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a user lifecycle status (ACTIVE / SUSPENDED / CLOSED)' })
  @ApiOkResponse({ description: 'The new lifecycle status.' })
  setUserStatus(
    @CurrentUser() admin: AuthContext,
    @Param('id', ParseUUIDPipe) targetUserId: string,
    @Body() dto: UserStatusRequestDto,
  ): Promise<StatusResult> {
    return this.platformAdmin.setUserStatus(admin.id, targetUserId, dto.status);
  }

  @Post('users/:id/wallet-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Freeze or unfreeze the user wallet' })
  @ApiOkResponse({ description: 'The new wallet status.' })
  setWalletStatus(
    @CurrentUser() admin: AuthContext,
    @Param('id', ParseUUIDPipe) targetUserId: string,
    @Body() dto: WalletStatusRequestDto,
  ): Promise<WalletStatusResult> {
    return this.platformAdmin.setWalletStatus(admin.id, targetUserId, dto.status);
  }
}
