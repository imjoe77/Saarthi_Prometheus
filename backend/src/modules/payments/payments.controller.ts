import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
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
import { CreateDepositDto } from './dto/create-deposit.dto';
import { DepositResponseDto } from './dto/deposit-response.dto';
import { PaymentsProviderResponseDto } from './dto/payments-provider-response.dto';
import { VerifyDepositDto } from './dto/verify-deposit.dto';
import { PaymentsService } from './payments.service';

/**
 * MODULE 03b — the caller's wallet top-ups.
 *
 * Every route resolves the wallet from the verified `@CurrentUser`; there is no
 * route by which one user can deposit into another's wallet, or read another's
 * deposits.
 *
 * This is the one place in the API where a browser causes a wallet to be
 * credited. It is safe to expose because the credit is bounded three ways: the
 * amount is a validated decimal, a single top-up may not exceed the configured
 * ceiling, and the deposit is idempotent on `(user, clientRequestId)`.
 */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('provider')
  @ApiOperation({
    summary: 'Describe the active payment rail',
    description:
      'Says which rail a top-up would use and how large a single top-up may be, so the browser can label the flow before the user types anything.',
  })
  @ApiOkResponse({ type: PaymentsProviderResponseDto })
  provider(): PaymentsProviderResponseDto {
    const info = this.paymentsService.getProviderInfo();

    return {
      provider: info.provider,
      maxDepositInr: info.maxDepositInr,
      requiresCheckout: info.requiresCheckout,
    };
  }

  @Post('deposits')
  @ApiOperation({
    summary: 'Add funds to the wallet',
    description:
      'Starts a top-up. On the simulated rail the deposit is credited to the ledger immediately and the wallet balance is spendable at once. On the Razorpay rail the deposit comes back PENDING with checkout details and is credited only once the payment is confirmed. Idempotent on (user, clientRequestId): 201 on first acceptance, 200 with the original deposit on a replay.',
  })
  @ApiCreatedResponse({ type: DepositResponseDto, description: 'Deposit started and credited.' })
  @ApiOkResponse({ type: DepositResponseDto, description: 'Replayed request; the original deposit, no balance moved.' })
  async create(
    @CurrentUser() user: AuthContext,
    @Body() body: CreateDepositDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DepositResponseDto> {
    const { deposit, created, checkout } = await this.paymentsService.create(user.id, body);

    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);

    return {
      ...DepositResponseDto.from(deposit),
      checkout: checkout ?? null,
    };
  }

  @Get('deposits')
  @ApiOperation({
    summary: "List the caller's top-ups",
    description:
      'Newest first. A deposit that is still PENDING has been started but not paid for, and holds no money yet. On the Razorpay rail such a deposit carries the checkout needed to resume the SAME order, so a payment sheet that was closed can be reopened instead of leaving an orphaned top-up behind.',
  })
  @ApiOkResponse({ type: [DepositResponseDto] })
  async list(@CurrentUser() user: AuthContext): Promise<DepositResponseDto[]> {
    const rows = await this.paymentsService.listWithCheckout(user.id);

    return rows.map(({ deposit, checkout }) => DepositResponseDto.from(deposit, checkout));
  }

  @Post('deposits/:id/verify')
  @ApiOperation({
    summary: 'Confirm a Razorpay payment and credit the deposit',
    description:
      'Recomputes the checkout signature from the order and payment ids with the key secret this service holds. A signature that does not match credits nothing.',
  })
  @ApiOkResponse({ type: DepositResponseDto })
  async verify(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: VerifyDepositDto,
  ): Promise<DepositResponseDto> {
    const deposit = await this.paymentsService.verify(user.id, id, body);

    return DepositResponseDto.from(deposit);
  }
}
