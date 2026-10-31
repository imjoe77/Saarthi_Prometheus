import { Prisma, TransactionType } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import type { WalletService } from '../wallet/wallet.service';
import { EmberStakingService } from './ember-staking.service';

describe('EmberStakingService (unit)', () => {
  const emberAsset = { id: 'asset-ember', symbol: 'EMBER', isActive: true };

  const prismaMock = {
    emberStakePosition: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    asset: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const walletServiceMock = {
    getOrCreateForUser: jest.fn(),
    lock: jest.fn(),
    unlock: jest.fn(),
  };
  const configMock = {
    emberStaking: { aprPercent: '8.4', lockDays: 30 },
  } as unknown as AppConfig;

  const service = () =>
    new EmberStakingService(
      configMock,
      prismaMock as unknown as PrismaService,
      walletServiceMock as unknown as WalletService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    (prismaMock.asset.findUnique as jest.Mock).mockResolvedValue(emberAsset);
    (prismaMock.emberStakePosition.findUnique as jest.Mock).mockResolvedValue(null);
    (prismaMock.emberStakePosition.create as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
    (prismaMock.emberStakePosition.update as jest.Mock).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock));
    walletServiceMock.getOrCreateForUser.mockResolvedValue({ wallet: { id: 'wallet-user' } });
    walletServiceMock.lock.mockResolvedValue({});
    walletServiceMock.unlock.mockResolvedValue({});
  });

  it('locks the stake into the wallet and records an ACTIVE position with the configured lock', async () => {
    const { position, created } = await service().stake('user-1', {
      emberAmount: '1000',
      clientRequestId: '9d8f1b2a-1234-5678-9abc-def012345678',
    });

    expect(walletServiceMock.lock).toHaveBeenCalledWith(
      'wallet-user',
      'asset-ember',
      new Prisma.Decimal('1000'),
      expect.objectContaining({ note: expect.stringContaining('EMBER stake position') }),
      expect.anything(),
    );
    expect(created).toBe(true);
    expect(position.status).toBe('ACTIVE');
    expect((position.lockUntil as Date).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  it('replays an existing position on the same key without touching the wallet', async () => {
    (prismaMock.emberStakePosition.findUnique as jest.Mock).mockResolvedValue({ stakeId: 's1', status: 'ACTIVE' });

    const { created } = await service().stake('user-1', {
      emberAmount: '1000',
      clientRequestId: '9d8f1b2a-1234-5678-9abc-def012345678',
    });
    expect(created).toBe(false);
    expect(walletServiceMock.lock).not.toHaveBeenCalled();
    expect(prismaMock.emberStakePosition.create).not.toHaveBeenCalled();
  });

  // A failing lock propagates before any record exists.
  it('rolls back the whole stake when the wallet cannot lock', async () => {
    walletServiceMock.lock.mockRejectedValue(new Error('no EMBER available to lock'));

    await expect(
      service().stake('user-1', { emberAmount: '1000', clientRequestId: '9d8f1b2a-1234-5678-9abc-def012345678' }),
    ).rejects.toThrow('no EMBER');
    expect(prismaMock.emberStakePosition.create).not.toHaveBeenCalled();
  });

  it('refuses unstaking for an id that is not one of the caller\'s positions (404, not 403)', async () => {
    (prismaMock.emberStakePosition.findUnique as jest.Mock).mockResolvedValue({ stakeId: 's1', userId: 'someone-else' });

    await expect(service().unstake('user-1', '9d8f1b2a-1234-5678-9abc-def012345678')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(walletServiceMock.unlock).not.toHaveBeenCalled();
  });

  it('refuses early unstaking while the lock still holds', async () => {
    (prismaMock.emberStakePosition.findUnique as jest.Mock).mockResolvedValue({
      stakeId: 's1',
      userId: 'user-1',
      status: 'ACTIVE',
      amount: new Prisma.Decimal('1000'),
      lockUntil: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      stakedAt: new Date(),
     unstakedAt: null,
    });

    await expect(
      service().unstake('user-1', '9d8f1b2a-1234-5678-9abc-def012345678'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(walletServiceMock.unlock).not.toHaveBeenCalled();
  });

  it('unlocks an expired position exactly once, then replays without moving balances', async () => {
    (prismaMock.emberStakePosition.findUnique as jest.Mock).mockResolvedValue({
      stakeId: 's1',
      userId: 'user-1',
      status: 'ACTIVE',
      amount: new Prisma.Decimal('1000'),
      lockUntil: new Date(Date.now() - 1000),
      stakedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      unstakedAt: null,
    });

    const { created } = await service().unstake('user-1', '9d8f1b2a-1234-5678-9abc-def012345678');
    expect(walletServiceMock.unlock).toHaveBeenCalledWith(
      'wallet-user',
      'asset-ember',
      new Prisma.Decimal('1000'),
      expect.objectContaining({ note: expect.stringContaining('unlocked') }),
      expect.anything(),
    );
    expect(prismaMock.emberStakePosition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stakeId: expect.any(String), status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'UNSTAKED' }),
      }),
    );
    expect(created).toBe(true);

    (prismaMock.emberStakePosition.findUnique as jest.Mock).mockResolvedValue({
      stakeId: 's1',
      userId: 'user-1',
      status: 'UNSTAKED',
      amount: new Prisma.Decimal('1000'),
      lockUntil: new Date(Date.now() - 1000),
      stakedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      unstakedAt: new Date(),
    });
    const replay = await service().unstake('user-1', '9d8f1b2a-1234-5678-9abc-def012345678');
    expect(replay.created).toBe(false);
    expect(walletServiceMock.unlock).toHaveBeenCalledTimes(1);
  });

  it('simulates rewards at the configured APR for the elapsed time, display-only', async () => {
    (prismaMock.emberStakePosition.findMany as jest.Mock).mockResolvedValue([
      {
        stakeId: 's1',
        userId: 'user-1',
        status: 'ACTIVE',
        amount: new Prisma.Decimal('1000'),
        lockUntil: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        stakedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        unstakedAt: null,
        clientRequestId: '9d8f1b2a-1234-5678-9abc-def012345678',
      },
    ]);

    const [position] = await service().positionsFor('user-1');
    if (!position) throw new Error('positionsFor returned no position');
    expect(position.simulation.aprPercent).toBe('8.4');
    expect(position.simulation.elapsedDays).toBeGreaterThanOrEqual(29);
    expect(parseFloat(position.simulation.simulatedReward)).toBeGreaterThan(6.5);
    expect(parseFloat(position.simulation.simulatedReward)).toBeLessThan(7);
  });
});
