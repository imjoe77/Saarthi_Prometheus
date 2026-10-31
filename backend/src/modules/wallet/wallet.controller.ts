import { Controller, Get, HttpStatus, Post, Query, Res } from '@nestjs/common';
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
import { BalanceResponseDto } from './dto/balance-response.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { TransactionPageDto } from './dto/transaction-page.dto';
import { TransactionResponseDto } from './dto/transaction-response.dto';
import { WalletResponseDto } from './dto/wallet-response.dto';
import { WalletService } from './wallet.service';

/**
 * MODULE 03 — the caller's wallet.
 *
 * There is no `GET /wallets/:id`. The wallet is always resolved from the verified
 * caller (`@CurrentUser`), so one user has no route by which to name another's
 * wallet. The `me` segment is literal, not a parameter - it reads as a path, but
 * there is nothing user-suppliable in it.
 *
 * Creation is the only write, and it only ever creates the caller's own empty
 * wallet. Balance movements are internal: they are invoked by trusted modules
 * through `WalletService`, never by a public request, because a public "credit
 * this asset" endpoint would be an infinite money endpoint.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post()
  @ApiOperation({
    summary: "Create the caller's wallet",
    description:
      'Idempotent. The first call creates the wallet and answers 201; any later call answers 200 with the same wallet. Balances are created lazily, when an asset is first credited.',
  })
  @ApiCreatedResponse({ type: WalletResponseDto, description: 'Wallet created.' })
  @ApiOkResponse({ type: WalletResponseDto, description: 'Wallet already existed.' })
  async create(
    @CurrentUser() user: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WalletResponseDto> {
    const { wallet, created } = await this.walletService.getOrCreateForUser(user.id);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return WalletResponseDto.from(wallet);
  }

  @Get('me')
  @ApiOperation({ summary: "Get the caller's wallet" })
  @ApiOkResponse({ type: WalletResponseDto })
  async me(@CurrentUser() user: AuthContext): Promise<WalletResponseDto> {
    const wallet = await this.walletService.getForUserOrThrow(user.id);
    return WalletResponseDto.from(wallet);
  }

  @Get('me/balances')
  @ApiOperation({
    summary: "List the caller's balances",
    description: 'One entry per asset the wallet holds. Amounts are strings at the asset display precision.',
  })
  @ApiOkResponse({ type: [BalanceResponseDto] })
  async balances(@CurrentUser() user: AuthContext): Promise<BalanceResponseDto[]> {
    const balances = await this.walletService.getBalances(user.id);
    return balances.map((balance) => BalanceResponseDto.from(balance));
  }

  @Get('me/transactions')
  @ApiOperation({
    summary: "List the caller's transaction history",
    description: 'Newest first, keyset-paginated. Pass the returned nextCursor back as ?cursor= for the next page.',
  })
  @ApiOkResponse({ type: TransactionPageDto })
  async transactions(
    @CurrentUser() user: AuthContext,
    @Query() query: ListTransactionsQueryDto,
  ): Promise<TransactionPageDto> {
    const page = await this.walletService.getTransactionPage(user.id, query);

    return {
      items: page.items.map((transaction) => TransactionResponseDto.from(transaction)),
      nextCursor: page.nextCursor,
    };
  }
}
