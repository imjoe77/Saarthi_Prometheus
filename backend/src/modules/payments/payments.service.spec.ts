import { Prisma, WalletDepositStatus } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import type { WalletService } from '../wallet/wallet.service';
import { PaymentsService } from './payments.service';
import type { RazorpayClient } from './razorpay.client';

/**
 * MODULE 03b — the payments service, unit-tested against hand-written Prisma
 * fakes.
 *
 * The behaviours worth pinning down here are the ones money depends on: the
 * credit is exactly once even when two confirmations arrive together, a
 * replay never moves a balance twice, and a provider that cannot be reached
 * leaves no deposit behind.
 */
describe('PaymentsService (unit)', () => {
  const inrAsset = { id: 'asset-inr', symbol: 'INR', decimals: 2, isActive: true };

  const prismaMock = {
    asset: { findUnique: jest.fn() },
    walletDeposit: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const walletServiceMock = {
    getOrCreateForUser: jest.fn(),
    credit: jest.fn(),
  };

  const razorpayMock = {
    keyId: 'rzp_test_123',
    createOrder: jest.fn(),
    verifyCheckoutSignature: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };

  const configMock = {
    payments: {
      provider: 'simulated',
      razorpayKeyId: '',
      razorpayKeySecret: '',
      razorpayWebhookSecret: '',
      maxDepositInr: '500000',
      requestTimeoutMs: 10000,
    },
  } as unknown as AppConfig;

  const razorpayConfigMock = {
    payments: {
      provider: 'razorpay',
      razorpayKeyId: 'rzp_test_123',
      razorpayKeySecret: 'secret',
      razorpayWebhookSecret: 'hook-secret',
      maxDepositInr: '500000',
      requestTimeoutMs: 10000,
    },
  } as unknown as AppConfig;

  /** The transaction client handed to the service inside $transaction. */
  let txClient: {
    walletDeposit: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };

  const uniqueViolation = (): Prisma.PrismaClientKnownRequestError =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  const depositRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'deposit-1',
    userId: 'user-1',
    assetId: 'asset-inr',
    amount: new Prisma.Decimal('5000'),
    status: WalletDepositStatus.SUCCEEDED,
    provider: 'simulated',
    providerReference: null,
    clientRequestId: 'req-1',
    note: null,
    createdAt: new Date('2026-10-28T09:00:00.000Z'),
    updatedAt: new Date('2026-10-28T09:00:00.000Z'),
    asset: inrAsset,
    ...overrides,
  });

  const service = (config: AppConfig = configMock) =>
    new PaymentsService(
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
      razorpayMock as unknown as RazorpayClient,
      config,
    );

  beforeEach(() => {
    jest.clearAllMocks();

    txClient = {
      walletDeposit: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => Promise.resolve(depositRow(data))),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(depositRow())),
      },
    };

    (prismaMock.$transaction).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
    );
    (prismaMock.asset.findUnique).mockResolvedValue(inrAsset);
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(null);
    (prismaMock.walletDeposit.create).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(depositRow(data)),
    );
    (prismaMock.walletDeposit.updateMany).mockResolvedValue({ count: 1 });
    walletServiceMock.getOrCreateForUser.mockResolvedValue({ wallet: { id: 'wallet-1' }, created: false });
    walletServiceMock.credit.mockResolvedValue({});
    razorpayMock.verifyCheckoutSignature.mockReturnValue(true);
    razorpayMock.verifyWebhookSignature.mockReturnValue(true);
  });

  // ---------------------------------------------------------------------------
  // The simulated rail
  // ---------------------------------------------------------------------------

  it('credits the wallet and records the deposit in one transaction', async () => {
    const { deposit, created, checkout } = await service().create('user-1', {
      clientRequestId: 'req-1',
      amountInr: '5000.00',
    });

    expect(created).toBe(true);
    expect(checkout).toBeNull();
    expect(deposit.status).toBe(WalletDepositStatus.SUCCEEDED);
    expect(deposit.provider).toBe('simulated');

    // The credit is made through WalletService - the only writer of the ledger.
    expect(walletServiceMock.credit).toHaveBeenCalledTimes(1);
    expect(walletServiceMock.credit.mock.calls[0][0]).toBe('wallet-1');
    expect(walletServiceMock.credit.mock.calls[0][1]).toBe('asset-inr');
    expect(walletServiceMock.credit.mock.calls[0][2]).toEqual(new Prisma.Decimal('5000'));

    // ...and inside the same transaction as the deposit row.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txClient.walletDeposit.create).toHaveBeenCalledTimes(1);
  });

  it('replays the original deposit on the same idempotency key without moving money again', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(depositRow());

    const { deposit, created } = await service().create('user-1', {
      clientRequestId: 'req-1',
      amountInr: '5000.00',
    });

    expect(created).toBe(false);
    expect(deposit.id).toBe('deposit-1');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('reads the winner back when a concurrent request took the idempotency key', async () => {
    (prismaMock.walletDeposit.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(depositRow({ id: 'deposit-winner' }));
    (prismaMock.$transaction).mockRejectedValueOnce(uniqueViolation());

    const { deposit, created } = await service().create('user-1', {
      clientRequestId: 'req-1',
      amountInr: '5000.00',
    });

    expect(created).toBe(false);
    expect(deposit.id).toBe('deposit-winner');
  });

  it('refuses an amount above the configured ceiling before anything is written', async () => {
    const error = await service()
      .create('user-1', { clientRequestId: 'req-1', amountInr: '900000.00' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('refuses a malformed amount', async () => {
    const error = await service()
      .create('user-1', { clientRequestId: 'req-1', amountInr: '12.345' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // The Razorpay rail
  // ---------------------------------------------------------------------------

  it('creates the provider order and leaves the deposit PENDING on the Razorpay rail', async () => {
    razorpayMock.createOrder.mockResolvedValue({ id: 'order_1', amount: 500000, currency: 'INR', status: 'created' });

    const { deposit, created, checkout } = await service(razorpayConfigMock).create('user-1', {
      clientRequestId: 'req-1',
      amountInr: '5000.00',
    });

    expect(created).toBe(true);
    expect(deposit.status).toBe(WalletDepositStatus.PENDING);
    expect(deposit.providerReference).toBe('order_1');
    expect(checkout).toEqual({
      keyId: 'rzp_test_123',
      orderId: 'order_1',
      amountPaise: 500000,
      currency: 'INR',
      depositId: deposit.id,
    });

    // Nothing is credited until the payment is confirmed.
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('carries the checkout on a pending deposit in the listing, so an interrupted payment can be resumed', async () => {
    (prismaMock.walletDeposit.findMany).mockResolvedValue([
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    ]);

    const rows = await service(razorpayConfigMock).listWithCheckout('user-1');
    const [first] = rows;

    expect(rows).toHaveLength(1);
    expect(first?.checkout).toEqual({
      keyId: 'rzp_test_123',
      orderId: 'order_1',
      amountPaise: 500000,
      currency: 'INR',
      depositId: 'deposit-1',
    });
  });

  it('offers no checkout for a deposit that already settled, so nothing is resumed twice', async () => {
    (prismaMock.walletDeposit.findMany).mockResolvedValue([
      depositRow({ status: WalletDepositStatus.SUCCEEDED, provider: 'razorpay', providerReference: 'order_1' }),
    ]);

    const [first] = await service(razorpayConfigMock).listWithCheckout('user-1');

    expect(first?.checkout).toBeNull();
  });

  it('offers no checkout on the simulated rail, where a top-up has nothing left to pay', async () => {
    (prismaMock.walletDeposit.findMany).mockResolvedValue([
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'simulated', providerReference: null }),
    ]);

    const [first] = await service().listWithCheckout('user-1');

    expect(first?.checkout).toBeNull();
  });

  it('refuses the deposit with a 503 when the provider cannot be reached, and writes no row', async () => {
    razorpayMock.createOrder.mockRejectedValue(new Error('connection refused'));

    const error = await service(razorpayConfigMock)
      .create('user-1', { clientRequestId: 'req-1', amountInr: '5000.00' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
    expect(prismaMock.walletDeposit.create).not.toHaveBeenCalled();
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('credits the deposit once when a valid checkout signature is verified', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    );

    await service(razorpayConfigMock).verify('user-1', 'deposit-1', {
      razorpayOrderId: 'order_1',
      razorpayPaymentId: 'pay_1',
      razorpaySignature: 'sig',
    });

    expect(walletServiceMock.credit).toHaveBeenCalledTimes(1);
    expect(txClient.walletDeposit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'deposit-1', status: WalletDepositStatus.PENDING },
      }),
    );
  });

  it('credits nothing when the checkout signature does not match', async () => {
    razorpayMock.verifyCheckoutSignature.mockReturnValue(false);
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    );

    const error = await service(razorpayConfigMock)
      .verify('user-1', 'deposit-1', {
        razorpayOrderId: 'order_1',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'forged',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('refuses a payment that belongs to a different order', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    );

    const error = await service(razorpayConfigMock)
      .verify('user-1', 'deposit-1', {
        razorpayOrderId: 'order_other',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'sig',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.CONFLICT);
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('does not credit a deposit that already holds money', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.SUCCEEDED, provider: 'razorpay', providerReference: 'order_1' }),
    );

    await service(razorpayConfigMock).verify('user-1', 'deposit-1', {
      razorpayOrderId: 'order_1',
      razorpayPaymentId: 'pay_1',
      razorpaySignature: 'sig',
    });

    expect(walletServiceMock.credit).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('does not credit a deposit that belongs to somebody else', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(depositRow({ userId: 'user-other' }));

    const error = await service()
      .verify('user-1', 'deposit-1', {
        razorpayOrderId: 'order_1',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'sig',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.NOT_FOUND);
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // The webhook
  // ---------------------------------------------------------------------------

  it('refuses a webhook whose signature does not match', async () => {
    razorpayMock.verifyWebhookSignature.mockReturnValue(false);

    const error = await service(razorpayConfigMock)
      .handleRazorpayWebhook(Buffer.from('{}'), 'forged')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('credits the deposit a captured webhook names', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    );

    const body = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 500000, currency: 'INR' } } },
      }),
    );

    await service(razorpayConfigMock).handleRazorpayWebhook(body, 'sig');

    expect(walletServiceMock.credit).toHaveBeenCalledTimes(1);
  });

  it('credits nothing when a captured webhook names a different amount', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    );

    const body = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 1, currency: 'INR' } } },
      }),
    );

    const error = await service(razorpayConfigMock)
      .handleRazorpayWebhook(body, 'sig')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).code).toBe(ERROR_CODES.CONFLICT);
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('marks a pending deposit FAILED when the payment failed', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    );

    const body = Buffer.from(
      JSON.stringify({
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 500000 } } },
      }),
    );

    await service(razorpayConfigMock).handleRazorpayWebhook(body, 'sig');

    expect(prismaMock.walletDeposit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'deposit-1', status: WalletDepositStatus.PENDING },
        data: expect.objectContaining({ status: WalletDepositStatus.FAILED }),
      }),
    );
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('does not fail a deposit that already holds money', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.SUCCEEDED, provider: 'razorpay', providerReference: 'order_1' }),
    );

    const body = Buffer.from(
      JSON.stringify({
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 500000 } } },
      }),
    );

    await service(razorpayConfigMock).handleRazorpayWebhook(body, 'sig');

    expect(prismaMock.walletDeposit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'deposit-1', status: WalletDepositStatus.PENDING } }),
    );
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('moves nothing when a repeated captured delivery finds no pending deposit to claim', async () => {
    (prismaMock.walletDeposit.findUnique).mockResolvedValue(
      depositRow({ status: WalletDepositStatus.PENDING, provider: 'razorpay', providerReference: 'order_1' }),
    );
    // The compare-and-swap matched no row: another confirmation already claimed it.
    txClient.walletDeposit.updateMany.mockResolvedValue({ count: 0 });

    const body = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 500000 } } },
      }),
    );

    await service(razorpayConfigMock).handleRazorpayWebhook(body, 'sig');

    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });

  it('acknowledges an event it does not act on, so the provider stops redelivering it', async () => {
    const body = Buffer.from(JSON.stringify({ event: 'refund.processed', payload: {} }));

    await expect(service(razorpayConfigMock).handleRazorpayWebhook(body, 'sig')).resolves.toBeUndefined();
    expect(walletServiceMock.credit).not.toHaveBeenCalled();
  });
});
