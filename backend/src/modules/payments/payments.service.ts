import { randomUUID } from 'node:crypto';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, TransactionType, WalletDepositStatus, type Asset, type WalletDeposit } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { normaliseAmount } from '../wallet/decimal.util';
import { WalletService } from '../wallet/wallet.service';
import type { CreateDepositDto } from './dto/create-deposit.dto';
import type { DepositCheckoutDto } from './dto/deposit-response.dto';
import type { VerifyDepositDto } from './dto/verify-deposit.dto';
import { PaymentsProviderError, RazorpayClient } from './razorpay.client';

/**
 * MODULE 03b — wallet top-ups.
 *
 * A top-up is the ONE way money enters a Prometheus wallet, and it ends in a
 * `transactions` row of type DEPOSIT. That is the point of the module: a user
 * who adds INR ends up holding spendable INR that the USDT exchange, the EMBER
 * hub and the staking book can all draw on, and the balance they see is the
 * ledger's own number rather than a figure invented for the screen.
 *
 * WHAT IS SIMULATED AND WHAT IS NOT. The credit is never simulated. What the
 * `simulated` rail simulates is the PAYMENT: no external provider is involved,
 * so the money appears without a bank, a UPI intent or a card. The `razorpay`
 * rail is the opposite - the money appears only after Razorpay confirms the
 * payment, through the checkout signature or through the `payment.captured`
 * webhook. Dropping test keys into the environment and flipping
 * `PAYMENTS_PROVIDER` switches between the two without a single line of
 * application logic changing, because both rails end in the same place: this
 * service's {@link creditDeposit}.
 *
 * IDEMPOTENCY IS A KEY, NOT A FLAG. `(userId, clientRequestId)` is unique. A
 * replay finds the original deposit and returns it without moving a balance
 * again; two racing requests with the same key both start, and the loser's
 * insert fails with a unique violation that rolls its whole transaction back,
 * so the credit applies exactly once across both.
 *
 * THE CREDIT IS EXACTLY ONCE, EVEN WHEN TWO CONFIRMATIONS ARRIVE. A Razorpay
 * deposit can be confirmed twice - once by the browser returning from checkout
 * and once by the webhook - and both may arrive at the same moment. The credit
 * is therefore guarded by a compare-and-swap inside the credit transaction:
 * only a PENDING deposit may become SUCCEEDED, and only the request that
 * flipped it credits the balance. The loser reads the finished deposit back and
 * moves nothing.
 *
 * The deposit's `providerReference` holds the provider's own identifier for the
 * attempt - the Razorpay ORDER id. It is what lets a webhook, which carries
 * only an order id, be matched back to a deposit without a second lookup table.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly razorpay: RazorpayClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Which rail is in force, so the browser can label the flow honestly. */
  getProviderInfo(): { provider: string; maxDepositInr: string; requiresCheckout: boolean } {
    const provider = this.config.payments.provider;

    return {
      provider,
      maxDepositInr: this.config.payments.maxDepositInr,
      requiresCheckout: provider === 'razorpay',
    };
  }

  /**
   * Starts a top-up.
   *
   * On the `simulated` rail the deposit is credited immediately and the
   * returned deposit is already SUCCEEDED. On the `razorpay` rail the deposit
   * comes back PENDING with the checkout details, and the money is credited
   * only after the payment is confirmed.
   */
  async create(userId: string, dto: CreateDepositDto): Promise<CreatedDeposit> {
    const inrAsset = await this.requireInrAsset();
    const amount = normaliseAmount(dto.amountInr, inrAsset);

    this.assertWithinCeiling(amount);

    const replay = await this.findReplay(userId, dto.clientRequestId);

    if (replay) {
      const deposit = await this.withAsset(replay);
      return { deposit, created: false, checkout: this.checkoutFor(deposit) };
    }

    if (this.config.payments.provider === 'razorpay') {
      return this.createRazorpayDeposit(userId, amount, dto.clientRequestId, inrAsset);
    }

    return this.createSimulatedDeposit(userId, amount, dto.clientRequestId, inrAsset);
  }

  /** The caller's deposits, newest first. */
  async list(userId: string, limit = 20): Promise<Array<WalletDeposit & { asset: Asset }>> {
    const rows = await this.prisma.walletDeposit.findMany({
      where: { userId },
      include: { asset: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
    });

    return rows;
  }

  /**
   * The caller's deposits WITH the checkout each one still needs, newest first.
   *
   * A top-up whose payment sheet was closed is neither credited nor forgotten:
   * it stays PENDING with its Razorpay order intact, and carrying the checkout
   * on the listing is what lets the browser REOPEN THAT SAME ORDER rather than
   * strand the deposit as an invisible row the user cannot resume or cancel.
   * Only a pending Razorpay deposit has a checkout; every other row answers
   * null, so the listing is otherwise identical to `list`.
   */
  async listWithCheckout(
    userId: string,
    limit = 20,
  ): Promise<Array<{ deposit: WalletDeposit & { asset: Asset }; checkout: DepositCheckoutDto | null }>> {
    const deposits = await this.list(userId, limit);

    return deposits.map((deposit) => ({ deposit, checkout: this.checkoutFor(deposit) }));
  }

  /**
   * Confirms a Razorpay checkout and credits the deposit.
   *
   * The three values come from Razorpay's checkout script. The signature is
   * recomputed here from the order and payment ids with the key secret this
   * process holds, so the browser cannot assert a payment it never made. The
   * order id must also be the one this deposit was created against, so a valid
   * signature for somebody else's order cannot be used to settle this one.
   */
  async verify(userId: string, depositId: string, dto: VerifyDepositDto): Promise<WalletDeposit & { asset: Asset }> {
    const deposit = await this.requireOwnDeposit(userId, depositId);

    if (deposit.status === WalletDepositStatus.SUCCEEDED) {
      return deposit;
    }

    if (deposit.status === WalletDepositStatus.FAILED) {
      throw DomainException.conflict('This deposit already failed. Start a new top-up.');
    }

    if (deposit.provider !== 'razorpay') {
      throw DomainException.badRequest('This deposit was not started on the Razorpay rail.');
    }

    if (deposit.providerReference !== dto.razorpayOrderId) {
      throw DomainException.conflict('The payment does not belong to this deposit.');
    }

    if (!this.razorpay.verifyCheckoutSignature(dto.razorpayOrderId, dto.razorpayPaymentId, dto.razorpaySignature)) {
      throw DomainException.badRequest('The payment signature did not match. Nothing was credited.');
    }

    const credited = await this.creditDeposit(deposit, {
      type: TransactionType.DEPOSIT,
      note: `INR deposit ${deposit.id} (Razorpay payment ${dto.razorpayPaymentId})`,
    });

    return credited;
  }

  /**
   * Handles a Razorpay webhook delivery.
   *
   * The delivery is authenticated by its signature over the raw body, because
   * a webhook carries no bearer token and arrives from the internet. An
   * unverified delivery is refused outright.
   *
   * Razorpay retries deliveries, so this must be safe to run twice - and it is,
   * because the credit is a compare-and-swap on the deposit's status.
   */
  async handleRazorpayWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      throw DomainException.badRequest('The webhook signature did not match.');
    }

    const payload = this.parseWebhook(rawBody);
    const event = payload.event;

    if (event !== 'payment.captured' && event !== 'payment.failed') {
      // An event this module does not act on (an authorised-but-uncaptured
      // payment, a refund) is acknowledged, not failed: refusing it would only
      // make the provider redeliver it forever.
      return;
    }

    const entity = payload.payload?.payment?.entity;

    if (!entity) {
      throw DomainException.badRequest('The webhook payload was not a payment event.');
    }

    if (event === 'payment.failed') {
      await this.failDeposit(entity.order_id);
      return;
    }

    const orderId = entity.order_id;

    if (!orderId) {
      throw DomainException.badRequest('The webhook carried no order id.');
    }

    const deposit = await this.prisma.walletDeposit.findUnique({ where: { providerReference: orderId } });

    if (!deposit) {
      throw DomainException.notFound('Deposit', orderId);
    }

    if (typeof entity.amount === 'number') {
      const expectedPaise = toPaise(deposit.amount);

      if (entity.amount !== expectedPaise) {
        throw DomainException.conflict(
          `The captured amount does not match the deposit. Nothing was credited.`,
          [`captured_paise:${entity.amount}`, `expected_paise:${expectedPaise}`],
        );
      }
    }

    const withAsset = await this.withAsset(deposit);

    await this.creditDeposit(withAsset, {
      type: TransactionType.DEPOSIT,
      note: `INR deposit ${deposit.id} (Razorpay payment ${entity.id ?? 'unknown'})`,
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The `simulated` rail: the deposit row and the ledger credit commit
   * together, or neither does.
   */
  private async createSimulatedDeposit(
    userId: string,
    amount: Prisma.Decimal,
    clientRequestId: string,
    inrAsset: Asset,
  ): Promise<CreatedDeposit> {
    const { wallet } = await this.walletService.getOrCreateForUser(userId);
    const depositId = randomUUID();

    try {
      const deposit = await this.prisma.$transaction(async (tx) => {
        const created = await tx.walletDeposit.create({
          data: {
            id: depositId,
            userId,
            assetId: inrAsset.id,
            amount,
            status: WalletDepositStatus.SUCCEEDED,
            provider: 'simulated',
            clientRequestId,
            note: 'Simulated INR top-up. No external payment provider was involved.',
          },
          include: { asset: true },
        });

        await this.walletService.credit(
          wallet.id,
          inrAsset.id,
          amount,
          { type: TransactionType.DEPOSIT, note: `INR deposit ${depositId}` },
          tx,
        );

        return created;
      });

      return { deposit, created: true, checkout: null };
    } catch (error) {
      // A concurrent request with the same key won: its transaction committed
      // the credit and ours rolled back, so the original is the truth.
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.findReplay(userId, clientRequestId);

        if (winner) {
          const deposit = await this.withAsset(winner);
          return { deposit, created: false, checkout: this.checkoutFor(deposit) };
        }
      }

      throw error;
    }
  }

  /**
   * The `razorpay` rail: create the provider order first, then record the
   * PENDING deposit that it belongs to.
   *
   * The order is created first because its receipt is the deposit's id, and
   * that is what lets a webhook find the deposit again. The cost is that a
   * failed insert leaves an unpaid order behind, which Razorpay expires.
   */
  private async createRazorpayDeposit(
    userId: string,
    amount: Prisma.Decimal,
    clientRequestId: string,
    inrAsset: Asset,
  ): Promise<CreatedDeposit> {
    const depositId = randomUUID();
    const amountPaise = toPaise(amount);

    let order: { id: string };

    try {
      order = await this.razorpay.createOrder({
        receipt: depositId,
        amountPaise,
        notes: { depositId, clientRequestId },
      });
    } catch (error) {
      const reason = error instanceof PaymentsProviderError ? error.message : 'unknown provider failure';
      this.logger.error(`Razorpay order creation failed: ${reason}`);

      throw new DomainException(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'The payment provider could not be reached. No deposit was started; try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      const deposit = await this.prisma.walletDeposit.create({
        data: {
          id: depositId,
          userId,
          assetId: inrAsset.id,
          amount,
          status: WalletDepositStatus.PENDING,
          provider: 'razorpay',
          providerReference: order.id,
          clientRequestId,
          note: 'INR top-up paid through Razorpay.',
        },
        include: { asset: true },
      });

      return { deposit, created: true, checkout: this.checkoutFor(deposit) };
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.findReplay(userId, clientRequestId);

        if (winner) {
          const deposit = await this.withAsset(winner);
          return { deposit, created: false, checkout: this.checkoutFor(deposit) };
        }
      }

      throw error;
    }
  }

  /**
   * Credits a PENDING deposit, exactly once.
   *
   * The compare-and-swap and the ledger credit share one transaction, so the
   * deposit cannot become SUCCEEDED without the money, and the money cannot be
   * credited without the deposit. A second confirmation - the webhook arriving
   * after the browser's verification - matches no row and moves nothing.
   */
  private async creditDeposit(
    deposit: WalletDeposit & { asset: Asset },
    context: { type: TransactionType; note: string },
  ): Promise<WalletDeposit & { asset: Asset }> {
    const { wallet } = await this.walletService.getOrCreateForUser(deposit.userId);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.walletDeposit.updateMany({
        where: { id: deposit.id, status: WalletDepositStatus.PENDING },
        data: { status: WalletDepositStatus.SUCCEEDED },
      });

      if (claimed.count > 0) {
        await this.walletService.credit(
          wallet.id,
          deposit.assetId,
          deposit.amount,
          { type: context.type, note: context.note },
          tx,
        );
      }

      const finished = await tx.walletDeposit.findUniqueOrThrow({
        where: { id: deposit.id },
        include: { asset: true },
      });

      return finished;
    });
  }

  /**
   * Records that a payment failed.
   *
   * Only a PENDING deposit may fail. A deposit that already holds money cannot
   * be flipped to FAILED by a late delivery, because that would contradict a
   * credit the ledger has already published.
   */
  private async failDeposit(orderId: string | undefined): Promise<void> {
    if (!orderId) {
      throw DomainException.badRequest('The webhook carried no order id.');
    }

    const deposit = await this.prisma.walletDeposit.findUnique({ where: { providerReference: orderId } });

    if (!deposit) {
      throw DomainException.notFound('Deposit', orderId);
    }

    await this.prisma.walletDeposit.updateMany({
      where: { id: deposit.id, status: WalletDepositStatus.PENDING },
      data: {
        status: WalletDepositStatus.FAILED,
        note: 'The payment was refused by the provider. Nothing was credited.',
      },
    });
  }

  /**
   * The checkout the browser must open, or null when there is nothing to pay.
   *
   * Only a PENDING deposit on the Razorpay rail has a checkout: a simulated
   * deposit is already settled, and a settled deposit has nothing left to pay.
   */
  private checkoutFor(deposit: WalletDeposit & { asset: Asset }): DepositCheckoutDto | null {
    if (deposit.provider !== 'razorpay') return null;
    if (deposit.status !== WalletDepositStatus.PENDING) return null;
    if (!deposit.providerReference) return null;

    return {
      keyId: this.razorpay.keyId,
      orderId: deposit.providerReference,
      amountPaise: toPaise(deposit.amount),
      currency: 'INR',
      depositId: deposit.id,
    };
  }

  /** Parses the webhook body, refusing anything that is not an object. */
  private parseWebhook(rawBody: Buffer | undefined): RazorpayWebhookPayload {
    if (!rawBody || rawBody.length === 0) {
      throw DomainException.badRequest('The webhook body was empty.');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw DomainException.badRequest('The webhook body was not valid JSON.');
    }

    if (parsed === null || typeof parsed !== 'object') {
      throw DomainException.badRequest('The webhook body was not an object.');
    }

    return parsed;
  }

  /** A deposit must exist AND belong to the caller; both failures look the same. */
  private async requireOwnDeposit(userId: string, depositId: string): Promise<WalletDeposit & { asset: Asset }> {
    const deposit = await this.prisma.walletDeposit.findUnique({
      where: { id: depositId },
      include: { asset: true },
    });

    if (!deposit || deposit.userId !== userId) {
      throw DomainException.notFound('Deposit', depositId);
    }

    return deposit;
  }

  private findReplay(userId: string, clientRequestId: string): Promise<WalletDeposit | null> {
    return this.prisma.walletDeposit.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
    });
  }

  private async withAsset(deposit: WalletDeposit): Promise<WalletDeposit & { asset: Asset }> {
    const asset = await this.prisma.asset.findUnique({ where: { id: deposit.assetId } });

    if (!asset) {
      throw DomainException.notFound('Asset', deposit.assetId);
    }

    return { ...deposit, asset };
  }

  private async requireInrAsset(): Promise<Asset> {
    const asset = await this.prisma.asset.findUnique({ where: { symbol: 'INR' } });

    if (!asset) {
      throw DomainException.notFound('Asset', 'INR');
    }

    if (!asset.isActive) {
      throw DomainException.assetInactive(asset.symbol);
    }

    return asset;
  }

  /** The abuse rail on a single top-up. */
  private assertWithinCeiling(amount: Prisma.Decimal): void {
    const ceiling = new Prisma.Decimal(this.config.payments.maxDepositInr);

    if (amount.gt(ceiling)) {
      throw DomainException.badRequest(
        `A single top-up may not exceed ₹${ceiling.toFixed(2)}.`,
        [`max_deposit_inr:${ceiling.toFixed(2)}`],
      );
    }
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

/** A deposit that was started, and whether this call was the one that started it. */
export interface CreatedDeposit {
  deposit: WalletDeposit & { asset: Asset };
  created: boolean;
  /** Present only when the deposit still has to be paid. */
  checkout: DepositCheckoutDto | null;
}

/**
 * Converts an INR amount into paise.
 *
 * Exact by construction: the deposit's amount carries at most the INR asset's
 * two decimal places, so multiplying by 100 cannot lose anything and the
 * result is always an integer.
 */
function toPaise(amount: Prisma.Decimal): number {
  return Number(amount.mul(100).toFixed(0));
}

/** The shape of a Razorpay payment webhook, as far as this module reads it. */
interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        error_code?: string;
        error_description?: string;
      };
    };
  };
}
