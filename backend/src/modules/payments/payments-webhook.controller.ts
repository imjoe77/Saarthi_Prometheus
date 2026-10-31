import { Controller, Headers, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

/**
 * MODULE 03b — inbound payment-provider webhooks.
 *
 * This controller is deliberately separate from the authenticated API and lives
 * on its own path, because a webhook is the one request in this service that
 * arrives without a bearer token: the caller is the payment provider, not a
 * user. Its credential is the signature header.
 *
 * THE RAW BODY MATTERS. Razorpay signs the exact bytes it sent, so the
 * signature can only be checked against the unparsed payload. Re-serialising
 * the JSON would change a single byte and the hash would not match - which is
 * why the application is created with `rawBody: true` (see the bootstrap) and
 * why this route reads `req.rawBody` rather than `@Body()`.
 */
@ApiTags('payments')
@Controller('payments/webhooks')
export class PaymentsWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('razorpay')
  @Public()
  @ApiOperation({
    summary: 'Razorpay payment webhook',
    description:
      'Credits or fails a deposit according to the signed event. Safe to receive more than once: the credit is a compare-and-swap on the deposit status, so a repeated delivery moves nothing.',
  })
  @ApiExcludeEndpoint()
  async razorpay(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature?: string,
  ): Promise<{ received: true }> {
    await this.paymentsService.handleRazorpayWebhook(request.rawBody, signature);

    return { received: true };
  }
}
