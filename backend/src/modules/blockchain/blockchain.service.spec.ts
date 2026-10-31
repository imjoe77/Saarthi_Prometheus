import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import type { AppConfig } from '../../config/config.module';
import type { PrismaService } from '../../database/prisma.service';
import { BlockchainService } from './blockchain.service';
import type { EmberChainGateway } from './gateway.provider';

describe('BlockchainService (unit)', () => {
  const enabledConfig = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      blockchain: {
        enabled: true,
        network: 'localhost',
        chainId: 31337,
        rpcUrl: 'http://127.0.0.1:8545',
        tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        treasuryAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        maxSupplyWhole: '100000000',
        deploymentBlock: 0,
        confirmations: 1,
        receiptTimeoutMs: 30000,
        minterPrivateKeyFile: '',
        treasurySignerPrivateKeyFile: '',
        minterMaxAmount: '100000',
        minterMonthlyLimit: '500000',
        ...overrides,
      },
    } as unknown as AppConfig);

  const disabledConfig = {
    blockchain: {
      enabled: false,
      network: 'local',
      chainId: 31337,
      rpcUrl: '',
      tokenAddress: '',
      treasuryAddress: '',
      deploymentBlock: 0,
      confirmations: 1,
      receiptTimeoutMs: 30000,
      minterPrivateKeyFile: '',
      treasurySignerPrivateKeyFile: '',
      minterMaxAmount: null,
      minterMonthlyLimit: null,
      maxSupplyWhole: null,
    },
  } as unknown as AppConfig;

  const buildService = (config: AppConfig, gateway: EmberChainGateway | null) => {
    const prismaMock = {
      emberMintRequest: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        aggregate: jest.fn(),
        count: jest.fn(),
      },
      tokenBurn: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      blockchainEvent: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        aggregate: jest.fn(),
      },
      transaction: { aggregate: jest.fn() },
      asset: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
      wallet: { findUnique: jest.fn() },
      walletBalance: { findUnique: jest.fn() },
      adminAuditLog: { create: jest.fn() },
    };
    return {
      service: new BlockchainService(
        config,
        prismaMock as unknown as PrismaService,
        gateway,
      ),
      prisma: prismaMock,
    };
  };

  const gatewayFor = (overrides: Record<string, unknown> = {}): EmberChainGateway => {
    const gateway = {
      chainId: jest.fn(async () => 31337),
      snapshot: jest.fn(async () => ({
        name: 'Prometheus Ember',
        symbol: 'EMBER',
        decimals: 18,
        totalSupply: '10000000.000000000000000000',
        maxSupply: '100000000.000000000000000000',
        treasuryBalance: '9500000.000000000000000000',
        treasuryAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      })),
      submitMint: jest.fn(async () => ({ txHash: '0x' + 'aa'.repeat(32) })),
      submitBurn: jest.fn(async () => ({ txHash: '0x' + 'bb'.repeat(32) })),
      waitForReceipt: jest.fn(async () => ({ status: 'success', blockNumber: '42' })),
      historyEvents: jest.fn(async () => []),
      receiptEvents: jest.fn(async () => []),
    };
    return { ...gateway, ...overrides } as unknown as EmberChainGateway;
  };

  it('refuses every chain call with 503 when the layer is disabled - a decision, not an outage', async () => {
    const { service } = buildService(disabledConfig, null);
    const current = await service.status();
    expect(current.enabled).toBe(false);
    expect(current.rpcReachable).toBeNull();
    expect(() => service.requireGateway()).toThrow(DomainException);
  });

  it('validates mint amounts through the shared EMBER amount parser before any chain call', async () => {
    const gateway = gatewayFor();
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.emberMintRequest.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.emberMintRequest.create as jest.Mock).mockResolvedValue({});

    await expect(
      service.createMint('admin-1', { amount: '0', clientRequestId: '298df0d1-5f4d-7645-8abc-def000000001' } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(gateway.submitMint).not.toHaveBeenCalled();
    expect(prisma.emberMintRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a mint beyond the configured per-mint and monthly budgets without broadcasting', async () => {
    const gateway = gatewayFor();
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.emberMintRequest.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.emberMintRequest.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null } });

    await expect(
      service.createMint('admin-1', { amount: '200000', clientRequestId: '298df0d1-5f4d-7645-8abc-def000000002' } as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.emberMintRequest.create).not.toHaveBeenCalled();
    expect(gateway.submitMint).not.toHaveBeenCalled();
  });

  // The idempotency key is checked before any validation or chain call.
  it('replays an existing mint request instead of minting twice', async () => {
    const gateway = gatewayFor();
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.emberMintRequest.findUnique as jest.Mock).mockResolvedValue({
      mintRequestId: 'mr-1',
      status: 'CONFIRMED',
    });

    const { created, request } = await service.createMint('admin-1', {
      amount: '1',
      clientRequestId: '298df0d1-5f4d-7645-8abc-def000000003',
    } as never);
    expect(created).toBe(false);
    expect(request).toMatchObject({ mintRequestId: 'mr-1' });
    expect(prisma.emberMintRequest.aggregate).not.toHaveBeenCalled();
  });

  it('drives a mint through PENDING -> SUBMITTED -> CONFIRMED and ingests its events', async () => {
    const gateway = gatewayFor({
      receiptEvents: jest.fn(async () => [
        {
          eventName: 'TokensMinted' as const,
          network: 'localhost',
          chainId: 31337,
          txHash: '0x' + 'aa'.repeat(32),
          blockNumber: '42',
          logIndex: 0,
          account: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          amount: '5000.000000000000000000',
          newTotalSupply: '10500000.000000000000000000',
        },
      ]),
    });
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.emberMintRequest.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: Record<string, string> }) => {
      if (where && where.requestId) return null;
      if (where && where.mintRequestId === 'mr-2') return { mintRequestId: 'mr-2', status: 'CONFIRMED' };
      return null;
    });
    (prisma.emberMintRequest.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null } });
    (prisma.emberMintRequest.create as jest.Mock).mockResolvedValue({
      mintRequestId: 'mr-2',
      requestId: '298df0d1-5f4d-7645-8abc-def000000004',
      status: 'PENDING',
      txHash: null,
    });
    (prisma.emberMintRequest.update as jest.Mock).mockResolvedValue({});
    (prisma.emberMintRequest.findFirst as jest.Mock).mockResolvedValue({ mintRequestId: 'mr-2' });
    (prisma.blockchainEvent.upsert as jest.Mock).mockResolvedValue({});
    (prisma.blockchainEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const { created } = await service.createMint('admin-1', {
      amount: '5000',
      clientRequestId: '298df0d1-5f4d-7645-8abc-def000000004',
    } as never);

    expect(created).toBe(true);
    expect(prisma.emberMintRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
    );
    expect(prisma.emberMintRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mintRequestId: 'mr-2' }, data: expect.objectContaining({ status: 'SUBMITTED' }) }),
    );
    expect(prisma.emberMintRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mintRequestId: 'mr-2' }, data: expect.objectContaining({ status: 'CONFIRMED', blockNumber: 42n }) }),
    );
    expect(prisma.blockchainEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amount: '5000.000000000000000000' }) }),
    );
    expect(prisma.blockchainEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mintRequestId: 'mr-2' } }),
    );
  });

  it('fails a mint whose transaction is reverted on-chain', async () => {
    const gateway = gatewayFor({ waitForReceipt: jest.fn(async () => ({ status: 'reverted' as const, blockNumber: '43' })) });
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.emberMintRequest.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: Record<string, string> }) => {
      if (where && where.requestId) return null;
      if (where && where.mintRequestId === 'mr-3') return { mintRequestId: 'mr-3', status: 'FAILED' };
      return null;
    });
    (prisma.emberMintRequest.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null } });
    (prisma.emberMintRequest.create as jest.Mock).mockResolvedValue({ mintRequestId: 'mr-3', requestId: '298df0d1-5f4d-7645-8abc-def000000005', status: 'PENDING', txHash: null });
    (prisma.emberMintRequest.update as jest.Mock).mockResolvedValue({});

    await service.createMint('admin-1', { amount: '5000', clientRequestId: '298df0d1-5f4d-7645-8abc-def000000005' } as never);
    expect(prisma.emberMintRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('refuses a failed mint of the same key with a refused replay (creating a FAILED row must be rejected externally)', async () => {
    const gateway = gatewayFor();
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.emberMintRequest.findUnique as jest.Mock).mockResolvedValue({
      mintRequestId: 'mr-4',
      requestId: '298df0d1-5f4d-7645-8abc-def000000006',
      status: 'FAILED',
      errorMessage: 'contract rejected the mint',
    });

    const { created } = await service.createMint('admin-1', {
      amount: '5000',
      clientRequestId: '298df0d1-5f4d-7645-8abc-def000000006',
    } as never);
    expect(created).toBe(false);
    expect(gateway.submitMint).not.toHaveBeenCalled();
  });

  it('propagates a ledger-only burn through NOT_REQUIRED -> PENDING -> SUBMITTED -> CONFIRMED without throwing on failures', async () => {
    const gateway = gatewayFor();
    const { service, prisma } = buildService(enabledConfig(), gateway);
    let onChainStatus = 'NOT_REQUIRED';
    (prisma.tokenBurn.findUnique as jest.Mock).mockImplementation(async () => ({
      burnId: 'burn-1',
      onChainStatus,
      onChainTxHash: null,
    }));
    (prisma.tokenBurn.updateMany as jest.Mock).mockImplementation(async (args: { data: { onChainStatus: string } }) => {
      onChainStatus = args.data.onChainStatus;
      return { count: 1 };
    });
    (prisma.tokenBurn.update as jest.Mock).mockImplementation(async (args: { data: { onChainStatus?: string } }) => {
      if (args.data.onChainStatus) onChainStatus = args.data.onChainStatus;
      return {};
    });

    await service.submitBurnForLedgerBurn('burn-1', '1500.000000000000000000', 'admin-1');

    expect(prisma.tokenBurn.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ onChainStatus: 'PENDING' }) }),
    );
    expect(prisma.tokenBurn.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { burnId: 'burn-1' }, data: expect.objectContaining({ onChainStatus: 'SUBMITTED', onChainTxHash: expect.any(String) }) }),
    );
    expect(prisma.tokenBurn.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { burnId: 'burn-1' }, data: expect.objectContaining({ onChainStatus: 'CONFIRMED' }) }),
    );
    expect(gateway.submitBurn).toHaveBeenCalledWith('1500.000000000000000000');
  });

  it('keeps an already-propagating burn hands-off (no double submit across concurrent calls)', async () => {
    const gateway = gatewayFor();
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.tokenBurn.findUnique as jest.Mock).mockResolvedValue({
      burnId: 'burn-1',
      onChainStatus: 'SUBMITTED',
      onChainTxHash: '0x' + 'cc'.repeat(32),
    });

    await service.submitBurnForLedgerBurn('burn-1', '1500.000000000000000000', 'admin-1');
    expect(gateway.submitBurn).not.toHaveBeenCalled();
  });

  it('compares the chain against the ledger without mutating anything, and classifies seed issuance', async () => {
    const gateway = gatewayFor();
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.asset.findUnique as jest.Mock).mockResolvedValue({ id: 'asset-ember' });
    (prisma.transaction.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal('12000000') } }) // issued
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal('1000000') } }) // withdrawn
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal('480000') } }); // burned
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'treasury-user' });
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ id: 'wallet-treasury' });
    (prisma.walletBalance.findUnique as jest.Mock).mockResolvedValue({ available: new Prisma.Decimal('9500000') });
    (prisma.emberMintRequest.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: new Prisma.Decimal('10000000') } });
    (prisma.emberMintRequest.count as jest.Mock).mockResolvedValue(0);
    (prisma.blockchainEvent.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal('10000000') } })
      .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal('100000') } });

    const report = await service.reconciliation();

    // On-chain totalSupply 10,000,000 vs ledger circulating 11,052,000 -> differs.
    expect(report.differences).toHaveLength(1);
    const firstDifference = report.differences[0];
    expect(firstDifference?.kind).toBe('total_supply_vs_ledger_circulating');
    expect(report.offChain.seedAndDemoIssuedEstimate).toBe('2000000.000000000000000000');
  });

  it('reports differences as a list for operators, never as an attempted side-effect', async () => {
    const gateway = gatewayFor({
      snapshot: jest.fn(async () => ({
        name: 'Prometheus Ember',
        symbol: 'EMBER',
        decimals: 18,
        totalSupply: '0.000000000000000000',
        maxSupply: '100000000.000000000000000000',
        treasuryBalance: '0.000000000000000000',
        treasuryAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      })),
    });
    const { service, prisma } = buildService(enabledConfig(), gateway);
    (prisma.asset.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.emberMintRequest.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null } });
    (prisma.emberMintRequest.count as jest.Mock).mockResolvedValue(0);
    (prisma.blockchainEvent.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null } });

    const report = await service.reconciliation();
    expect(report.offChain.treasuryAvailableEmber).toBeNull();
    expect(report.differences).toEqual([]);
  });
});
