import { Prisma, TransactionType } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { TreasuryReserveGuard } from './treasury-reserve.guard';

/**
 * Decision coverage for the atomic reserve guard: the advisory lock key, the
 * DEPOSIT-only funding basis, the balance read, the exact floor comparison,
 * the INSUFFICIENT_BALANCE precedence, and the zero-basis safety. The lock's
 * real serialising behaviour and the rollback guarantees are proven against
 * the real database in `test/treasury.e2e-spec.ts`.
 */
describe('TreasuryReserveGuard (unit)', () => {
  const walletId = 'wallet-treasury';
  const assetId = 'asset-ember';

  const txMock = {
    $executeRaw: jest.fn(),
    transaction: { aggregate: jest.fn() },
    walletBalance: { findUnique: jest.fn() },
  };

  const guard = () => new TreasuryReserveGuard();

  const fundingOf = (sum: string | null): void => {
    txMock.transaction.aggregate.mockResolvedValue({
      _sum: { amount: sum === null ? null : new Prisma.Decimal(sum) },
    });
  };

  const available = (value: string | null): void => {
    txMock.walletBalance.findUnique.mockResolvedValue(
      value === null ? null : { available: new Prisma.Decimal(value) },
    );
  };

  const debit = (amount: string) => guard().assertDiscretionaryEmberDebit(txMock as never, {
    walletId,
    assetId,
    amount: new Prisma.Decimal(amount),
  });

  beforeEach(() => {
    jest.resetAllMocks();
    fundingOf('1000000');
    available('1000000');
  });

  it('takes a transaction-scoped advisory lock keyed to the treasury wallet', async () => {
    await debit('5');

    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
    // The raw query carries the lock key as its bound parameter.
    const [strings, key] = txMock.$executeRaw.mock.calls[0] as unknown as [string[], string];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe(`treasury_reserve:${walletId}`);
  });

  it('aggregates the funding basis from COMPLETED DEPOSIT legs on this wallet only', async () => {
    await debit('5');

    expect(txMock.transaction.aggregate).toHaveBeenCalledWith({
      where: {
        walletId,
        assetId,
        type: TransactionType.DEPOSIT,
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });
  });

  it('allows a burn that lands strictly above the floor', async () => {
    await expect(debit('699995')).resolves.toBeUndefined();
  });

  it('allows a burn that lands exactly on the floor', async () => {
    await expect(debit('700000')).resolves.toBeUndefined();
  });

  it('rejects a burn that would take available below the floor', async () => {
    await expect(debit('700001')).rejects.toMatchObject({
      code: ERROR_CODES.TREASURY_RESERVE_BREACH,
    });
  });

  it('defers to INSUFFICIENT_BALANCE when the balance cannot cover the amount at all', async () => {
    // Available 100, requested 500: the debit that follows will refuse with
    // INSUFFICIENT_BALANCE - the guard must not mask it with a breach.
    available('100');

    await expect(debit('500')).resolves.toBeUndefined();
  });

  it('treats a zero funding basis as a zero floor - never fabricated', async () => {
    fundingOf(null);

    // Any burn the balance can fund is allowed; the emptiness is what
    // refuses an unfunded treasury, via the debit itself.
    available('0');
    await expect(debit('1')).resolves.toBeUndefined();

    available('50');
    await expect(debit('50')).resolves.toBeUndefined();
  });

  it('treats a missing balance row as zero available and defers to the debit', async () => {
    available(null);

    await expect(debit('1')).resolves.toBeUndefined();
  });

  it('refuses with the exact floor, available and requested figures in the error details', async () => {
    available('400000');

    await expect(debit('150000')).rejects.toMatchObject({
      code: ERROR_CODES.TREASURY_RESERVE_BREACH,
      details: ['reserve_floor:300000', 'treasury_available:400000', 'requested:150000'],
    });
  });
});
