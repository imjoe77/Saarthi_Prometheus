import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentsController } from './payments.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { PaymentsService } from './payments.service';
import { RazorpayClient } from './razorpay.client';

/**
 * MODULE 03b — wallet top-ups.
 *
 * Imports `WalletModule` because a top-up ends in a ledger credit, and
 * `WalletService` is the only thing in the codebase allowed to write the
 * ledger. This module has no direct access to `wallet_balances` or
 * `transactions`; it asks the wallet service to move the money inside its own
 * transaction, so the deposit record and the credit commit together.
 *
 * `RazorpayClient` is always registered, even on the simulated rail: it holds
 * no state and makes no call until it is asked to. That keeps the module's
 * shape identical whichever rail is in force, so flipping
 * `PAYMENTS_PROVIDER` is a configuration change and nothing else.
 */
@Module({
  imports: [AppConfigModule, WalletModule],
  controllers: [PaymentsController, PaymentsWebhookController],
  providers: [PaymentsService, RazorpayClient],
  exports: [PaymentsService],
})
export class PaymentsModule {}
