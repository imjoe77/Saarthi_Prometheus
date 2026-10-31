import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { DomainException } from '../../common/errors/domain.exception';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { Prisma, type EmberMintRequest } from '@prisma/client';
import { parseEmberAmount } from '../tokenomics/domain/allocation-math';
import {
  EMBER_GATEWAY,
  type EmberChainGateway,
} from './gateway.provider';
import type { ContractEventOccurrence } from './viem-ember-gateway';

const TREASURY_USER_EMAIL = 'treasury@prometheus.local';

/** Contract reverts (cap exceeded etc.) read as a rejected request, not an outage. */
function looksLikeContractRevert(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = error instanceof Error ? error.message : String(error);
  return name.includes('ContractFunctionExecutionError') || /revert/i.test(message);
}

function shortErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 300);
}

function monthWindowUtc(reference: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1));
  return { start, end };
}

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(EMBER_GATEWAY) private readonly gateway: EmberChainGateway | null,
  ) {}

  /** The gateway is missing whenever the layer is disabled; use this to fail fast with 503. */
  requireGateway(): EmberChainGateway {
    if (!this.config.blockchain.enabled || !this.gateway) {
      throw new DomainException(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'The blockchain layer is disabled. Deploy the token contracts and set BLOCKCHAIN_ENABLED=true.',
        HttpStatus.SERVICE_UNAVAILABLE,
        ['blockchain_disabled'],
      );
    }
    return this.gateway;
  }

  isEnabled(): boolean {
    return this.config.blockchain.enabled && this.gateway !== null;
  }

  async status(): Promise<{
    enabled: boolean;
    network: string;
    chainId: number;
    rpcConfigured: boolean;
    tokenAddress: string | null;
    treasuryAddress: string | null;
    minterSignerConfigured: boolean;
    treasurySignerConfigured: boolean;
    maxSupplyWhole: string | null;
    deploymentBlock: number;
    confirmations: number;
    rpcReachable: boolean | null;
  }> {
    const blockchain = this.config.blockchain;
    let rpcReachable: boolean | null = null;
    if (blockchain.enabled && blockchain.rpcUrl) {
      try {
        await this.gateway?.chainId();
        rpcReachable = true;
      } catch {
        rpcReachable = false;
      }
    }
    return {
      enabled: blockchain.enabled,
      network: blockchain.network,
      chainId: blockchain.chainId,
      rpcConfigured: blockchain.rpcUrl.length > 0,
      tokenAddress: blockchain.tokenAddress || null,
      treasuryAddress: blockchain.treasuryAddress || null,
      minterSignerConfigured: blockchain.minterPrivateKeyFile.length > 0,
      treasurySignerConfigured: blockchain.treasurySignerPrivateKeyFile.length > 0,
      maxSupplyWhole: blockchain.maxSupplyWhole,
      deploymentBlock: blockchain.deploymentBlock,
      confirmations: blockchain.confirmations,
      rpcReachable,
    };
  }

  async createMint(
    adminUserId: string,
    dto: { amount: string; clientRequestId: string; reason?: string },
  ): Promise<{ request: EmberMintRequest; created: boolean }> {
    // Amount syntax is a body concern: it is refused with a precise 400 even
    // while the layer is disabled (only well-formed requests meet the 503).
    const amount = parseEmberAmount(dto.amount);
    const gateway = this.requireGateway();
    const blockchain = this.config.blockchain;

    const replayed = await this.prisma.emberMintRequest.findUnique({
      where: { requestId: dto.clientRequestId },
    });
    if (replayed) {
      return { request: replayed, created: false };
    }

    if (blockchain.minterMaxAmount !== null && amount.greaterThan(new Prisma.Decimal(blockchain.minterMaxAmount))) {
      throw DomainException.conflict(
        `A single mint may not exceed the configured maximum of ${blockchain.minterMaxAmount} EMBER.`,
        [`minter_max_amount:${blockchain.minterMaxAmount}`],
      );
    }
    if (blockchain.minterMonthlyLimit !== null) {
      const window = monthWindowUtc();
      const aggregate = await this.prisma.emberMintRequest.aggregate({
        _sum: { amount: true },
        where: {
          requestedAt: { gte: window.start, lt: window.end },
          status: { in: ['PENDING', 'SUBMITTED', 'CONFIRMED'] },
        },
      });
      const mintedThisMonth = aggregate._sum.amount ?? new Prisma.Decimal(0);
      if (mintedThisMonth.plus(amount).greaterThan(new Prisma.Decimal(blockchain.minterMonthlyLimit))) {
        throw DomainException.conflict(
          `This mint would exceed the monthly minting budget (${blockchain.minterMonthlyLimit} EMBER; ${mintedThisMonth.toFixed(18)} already consumed this month).`,
          [`monthly_mint_limit:${blockchain.minterMonthlyLimit}`, `minted_this_month:${mintedThisMonth.toFixed(18)}`],
        );
      }
    }

    const created = await this.prisma.emberMintRequest.create({
      data: {
        requestId: dto.clientRequestId,
        amount,
        status: 'PENDING',
        requestedBy: adminUserId,
        reason: dto.reason ?? null,
        network: blockchain.network,
        chainId: blockchain.chainId,
      },
    });
    await this.audit(adminUserId, 'ember.mint.requested', { mintRequestId: created.mintRequestId, amount: amount.toFixed(18), reason: dto.reason ?? null });

    try {
      const { txHash } = await gateway.submitMint(amount.toFixed(18));
      await this.prisma.emberMintRequest.update({
        where: { mintRequestId: created.mintRequestId },
        data: { status: 'SUBMITTED', txHash },
      });
      await this.audit(adminUserId, 'ember.mint.submitted', { mintRequestId: created.mintRequestId, txHash });

      const receipt = await gateway.waitForReceipt(txHash, blockchain.receiptTimeoutMs);
      if (receipt.status === 'success') {
        await this.prisma.emberMintRequest.update({
          where: { mintRequestId: created.mintRequestId },
          data: { status: 'CONFIRMED', blockNumber: BigInt(receipt.blockNumber), confirmedAt: new Date() },
        });
        await this.ingestReceiptEvents(txHash);
        await this.audit(adminUserId, 'ember.mint.confirmed', { mintRequestId: created.mintRequestId, txHash, blockNumber: receipt.blockNumber });
      } else {
        await this.prisma.emberMintRequest.update({
          where: { mintRequestId: created.mintRequestId },
          data: { status: 'FAILED', errorMessage: 'The mint transaction was reverted on-chain.', failedAt: new Date() },
        });
        await this.audit(adminUserId, 'ember.mint.failed', { mintRequestId: created.mintRequestId, txHash });
      }
    } catch (error) {
      const message = shortErrorText(error);
      const txHashNow = (await this.prisma.emberMintRequest.findUnique({
        where: { mintRequestId: created.mintRequestId },
        select: { txHash: true, status: true },
      })) ?? { txHash: null, status: 'PENDING' };
      if (txHashNow.status === 'SUBMITTED' && txHashNow.txHash) {
        await this.prisma.emberMintRequest.update({
          where: { mintRequestId: created.mintRequestId },
          data: { errorMessage: `Broadcast done but the receipt could not be confirmed: ${message}` },
        });
      } else if (txHashNow.status === 'PENDING' || txHashNow.status === 'SUBMITTED') {
        await this.prisma.emberMintRequest.update({
          where: { mintRequestId: created.mintRequestId },
          data: { status: 'FAILED', errorMessage: message, failedAt: new Date() },
        });
      }
      await this.audit(adminUserId, 'ember.mint.failed', { mintRequestId: created.mintRequestId, error: message });
      this.logger.warn(`Mint ${created.mintRequestId} failed: ${message}`);
      if (looksLikeContractRevert(error)) {
        throw DomainException.conflict(`The token contract rejected the mint: ${message}`);
      }
      throw new DomainException(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        `The mint transaction could not be completed: ${message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const final = (await this.findRequest(created.mintRequestId))!;
    return { request: final, created: true };
  }

  async findRequest(mintRequestId: string) {
    const row = await this.prisma.emberMintRequest.findUnique({ where: { mintRequestId } });
    if (!row) throw DomainException.notFound('Mint request', mintRequestId);
    return row;
  }

  listMints(limit: number) {
    return this.prisma.emberMintRequest.findMany({
      orderBy: { requestedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Recovers mint requests left mid-flight by crashes or RPC outages:
   * SUBMITTED rows get their receipt re-checked (self-healing), PENDING rows
   * are left untouched as an operator-visible open item, because a crash
   * before the submit leaves no way to know whether a broadcast happened.
   */
  async runRecovery(): Promise<{ examined: number; confirmed: number; failed: number; stillOpen: number }> {
    const gateway = this.requireGateway();
    const blockchain = this.config.blockchain;
    const open = await this.prisma.emberMintRequest.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
    });

    let confirmed = 0;
    let failed = 0;
    let stillOpen = 0;
    for (const row of open) {
      if (!row.txHash) {
        stillOpen += 1;
        continue;
      }
      try {
        const receipt = await gateway.waitForReceipt(row.txHash as `0x${string}`, blockchain.receiptTimeoutMs);
        if (receipt.status === 'success') {
          await this.prisma.emberMintRequest.update({
            where: { mintRequestId: row.mintRequestId },
            data: { status: 'CONFIRMED', blockNumber: BigInt(receipt.blockNumber), confirmedAt: new Date(), errorMessage: null },
          });
          confirmed += 1;
        } else {
          await this.prisma.emberMintRequest.update({
            where: { mintRequestId: row.mintRequestId },
            data: { status: 'FAILED', errorMessage: 'The mint transaction was reverted on-chain.', failedAt: new Date() },
          });
          failed += 1;
        }
      } catch {
        stillOpen += 1;
      }
    }
    return { examined: open.length, confirmed, failed, stillOpen };
  }

  /** Pull-based ingestion of contract events from the deployment block. */
  async syncEvents(): Promise<{ fromBlock: number; toBlock: string; scanned: number; ingested: number; linked: number }> {
    const occurrences = await (await this.requireGateway()).historyEvents(this.config.blockchain.deploymentBlock);
    let ingested = 0;
    let linked = 0;

    for (const occurrence of occurrences) {
      const wasCreated = await this.upsertEvent(occurrence);
      if (wasCreated) ingested += 1;
    }

    for (const occurrence of occurrences) {
      linked += await this.linkEventtoRecord(occurrence);
    }

    const toBlock = occurrences.reduce((max: number, occurrence: ContractEventOccurrence) => Math.max(max, Number(occurrence.blockNumber)), this.config.blockchain.deploymentBlock);
    return {
      fromBlock: this.config.blockchain.deploymentBlock,
      toBlock: String(toBlock),
      scanned: occurrences.length,
      ingested,
      linked,
    };
  }

  /** Writes one receipt's events after a mint/burn confirmation; always safe to call. */
  async ingestReceiptEvents(txHash: string): Promise<void> {
    if (!this.isEnabled() || !this.gateway) return;
    try {
      const occurrences = await this.gateway.receiptEvents(txHash as `0x${string}`);
      for (const occurrence of occurrences) {
        await this.upsertEvent(occurrence);
        await this.linkEventtoRecord(occurrence);
      }
    } catch (error) {
      const message = shortErrorText(error);
      this.logger.warn(`Event ingestion for ${txHash} failed: ${message}`);
    }
  }

  private async upsertEvent(occurrence: ContractEventOccurrence): Promise<boolean> {
    try {
      await this.prisma.blockchainEvent.upsert({
        where: {
          chainId_txHash_logIndex: {
            chainId: occurrence.chainId,
            txHash: occurrence.txHash,
            logIndex: occurrence.logIndex,
          },
        },
        create: {
          network: occurrence.network,
          chainId: occurrence.chainId,
          txHash: occurrence.txHash,
          blockNumber: BigInt(occurrence.blockNumber),
          logIndex: occurrence.logIndex,
          eventType: occurrence.eventName,
          payload: { newTotalSupply: occurrence.newTotalSupply },
          amount: occurrence.amount,
          account: occurrence.account,
        },
        update: {},
      });
      return true;
    } catch (error) {
      const message = shortErrorText(error);
      if (/Unique constraint/i.test(message)) return false;
      this.logger.warn(`Failed to ingest event ${occurrence.txHash}:${occurrence.logIndex}: ${message}`);
      return false;
    }
  }

  private async linkEventtoRecord(occurrence: ContractEventOccurrence): Promise<number> {
    try {
      if (occurrence.eventName === 'TokensMinted') {
        const request = await this.prisma.emberMintRequest.findFirst({
          where: { txHash: occurrence.txHash },
          select: { mintRequestId: true },
        });
        if (!request) return 0;
        const update = await this.prisma.blockchainEvent.updateMany({
          where: { chainId: occurrence.chainId, txHash: occurrence.txHash, logIndex: occurrence.logIndex, mintRequestId: null },
          data: { mintRequestId: request.mintRequestId },
        });
        return update.count;
      }
      const burn = await this.prisma.tokenBurn.findFirst({
        where: { onChainTxHash: occurrence.txHash },
        select: { burnId: true },
      });
      if (!burn) return 0;
      const update = await this.prisma.blockchainEvent.updateMany({
        where: { chainId: occurrence.chainId, txHash: occurrence.txHash, logIndex: occurrence.logIndex, burnId: null },
        data: { burnId: burn.burnId },
      });
      return update.count;
    } catch (error) {
      const message = shortErrorText(error);
      if (/Unique constraint/i.test(message)) return 0;
      this.logger.warn(`Failed to link event ${occurrence.txHash}:${occurrence.logIndex}: ${message}`);
      return 0;
    }
  }

  /**
   * The appendix: every burn the off-chain ledger records is offered to the
   * chain (callback from TokenomicsService after its commit). Never throws.
   */
  async submitBurnForLedgerBurn(
    burnId: string,
    amount: string,
    auditActorUserId: string,
  ): Promise<void> {
    if (!this.isEnabled()) return;
    const gateway = this.gateway;
    if (!gateway) return;
    try {
      const burn = await this.prisma.tokenBurn.findUnique({
        where: { burnId },
        select: { burnId: true, onChainStatus: true, onChainTxHash: true },
      });
      if (!burn) return;
      if (burn.onChainStatus !== 'NOT_REQUIRED' && burn.onChainStatus !== 'FAILED') return;
      if (burn.onChainStatus === 'FAILED' && burn.onChainTxHash) return;

      const startStates: ('NOT_REQUIRED' | 'FAILED')[] =
        burn.onChainTxHash ? ['NOT_REQUIRED'] : ['NOT_REQUIRED', 'FAILED'];
      const claim = await this.prisma.tokenBurn.updateMany({
        where: { burnId, onChainStatus: { in: startStates } },
        data: { onChainStatus: 'PENDING', onChainUpdatedAt: new Date() },
      });
      if (claim.count === 0) return;

      const { txHash } = await gateway.submitBurn(amount);
      await this.prisma.tokenBurn.update({
        where: { burnId },
        data: { onChainStatus: 'SUBMITTED', onChainTxHash: txHash, onChainUpdatedAt: new Date() },
      });

      const receipt = await gateway.waitForReceipt(txHash, this.config.blockchain.receiptTimeoutMs);
      if (receipt.status === 'success') {
        await this.prisma.tokenBurn.update({
          where: { burnId },
          data: {
            onChainStatus: 'CONFIRMED',
            onChainBlockNumber: BigInt(receipt.blockNumber),
            onChainUpdatedAt: new Date(),
          },
        });
      } else {
        await this.prisma.tokenBurn.update({ where: { burnId }, data: { onChainStatus: 'FAILED', onChainUpdatedAt: new Date() } });
      }
      await this.ingestReceiptEvents(txHash);
      await this.audit(auditActorUserId, 'ember.burn.propagated', { burnId, txHash, status: receipt.status });
    } catch (error) {
      const message = shortErrorText(error);
      try {
        await this.prisma.tokenBurn.updateMany({
          where: {
            burnId,
            onChainStatus: { in: ['NOT_REQUIRED', 'PENDING', 'SUBMITTED'] },
            OR: [{ onChainTxHash: null }, { onChainStatus: { not: 'SUBMITTED' } }],
          },
          data: { onChainStatus: 'FAILED', onChainUpdatedAt: new Date() },
        });
      } catch (rollbackError) {
        this.logger.warn(`Burn propagation failure bookkeeping for ${burnId} also failed: ${shortErrorText(rollbackError)}`);
      }
      await this.audit(auditActorUserId, 'ember.burn.propagation_failed', { burnId, error: message }).catch(() => undefined);
      this.logger.warn(`Burn ${burnId} propagation failed: ${message}`);
    }
  }

  /** On-chain vs PostgreSQL comparison. Never mutates data. */
  async reconciliation(): Promise<{
    onChain: {
      totalSupply: string;
      maxSupply: string;
      treasuryBalance: string;
      mintedEventsTotal: string;
      burnedEventsTotal: string;
    };
    offChain: {
      ledgerIssuedSupply: string;
      ledgerBurnedSupply: string;
      ledgerCirculatingSupply: string;
      treasuryAvailableEmber: string | null;
      confirmedMintRequestsTotal: string;
      seedAndDemoIssuedEstimate: string;
      confirmedMintsWithMissingEvent: number;
      unconfirmedMintRequests: number;
    };
    differences: { kind: string; onChainValue: string; offChainValue: string }[];
  }> {
    const gateway = this.requireGateway();
    const snapshot = await gateway.snapshot();

    const ember = await this.prisma.asset.findUnique({ where: { symbol: 'EMBER' }, select: { id: true } });
    let ledgerIssued = new Prisma.Decimal(0);
    let ledgerWithdrawn = new Prisma.Decimal(0);
    let ledgerBurned = new Prisma.Decimal(0);
    let treasuryAvailable: string | null = null;
    if (ember) {
      const issued = await this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { assetId: ember.id, type: 'DEPOSIT' },
      });
      const withdrawn = await this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { assetId: ember.id, type: 'WITHDRAWAL' },
      });
      const burned = await this.prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { assetId: ember.id, type: 'BURN' },
      });
      ledgerIssued = issued._sum.amount ?? new Prisma.Decimal(0);
      ledgerWithdrawn = withdrawn._sum.amount ?? new Prisma.Decimal(0);
      ledgerBurned = burned._sum.amount ?? new Prisma.Decimal(0);

      const treasuryUser = await this.prisma.user.findUnique({
        where: { email: TREASURY_USER_EMAIL },
        select: { id: true },
      });
      if (treasuryUser) {
        const wallet = await this.prisma.wallet.findUnique({
          where: { userId: treasuryUser.id },
          select: { id: true },
        });
        if (wallet) {
          const row = await this.prisma.walletBalance.findUnique({
            where: { walletId_assetId: { walletId: wallet.id, assetId: ember.id } },
            select: { available: true },
          });
          treasuryAvailable = row?.available.toFixed(18) ?? null;
        }
      }
    }

    const confirmedMintsAggregate = await this.prisma.emberMintRequest.aggregate({
      _sum: { amount: true },
      where: { status: 'CONFIRMED' },
    });
    const confirmedMintRequestsTotal = confirmedMintsAggregate._sum.amount ?? new Prisma.Decimal(0);
    const unconfirmedMintRequests = await this.prisma.emberMintRequest.count({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
    });
    const confirmedMintsWithMissingEvent = await this.prisma.emberMintRequest.count({
      where: { status: 'CONFIRMED', events: { none: {} } },
    });
    const mintedEventsAggregate = await this.prisma.blockchainEvent.aggregate({
      _sum: { amount: true },
      where: { eventType: 'TokensMinted' },
    });
    const burnedEventsAggregate = await this.prisma.blockchainEvent.aggregate({
      _sum: { amount: true },
      where: { eventType: 'TokensBurned' },
    });
    const mintedEventsTotal = mintedEventsAggregate._sum.amount ?? new Prisma.Decimal(0);
    const burnedEventsTotal = burnedEventsAggregate._sum.amount ?? new Prisma.Decimal(0);

    const ledgerCirculating = ledgerIssued.minus(ledgerWithdrawn).minus(ledgerBurned);
    const seedAndDemoIssuedEstimate = ledgerIssued.minus(confirmedMintRequestsTotal).lessThan(0)
      ? new Prisma.Decimal(0)
      : ledgerIssued.minus(confirmedMintRequestsTotal);

    const differences: { kind: string; onChainValue: string; offChainValue: string }[] = [];
    const compare = (kind: string, onChainValue: Prisma.Decimal | null, offChainValue: Prisma.Decimal | null) => {
      if (!onChainValue || !offChainValue) return;
      if (!onChainValue.eq(offChainValue)) {
        differences.push({ kind, onChainValue: onChainValue.toFixed(18), offChainValue: offChainValue.toFixed(18) });
      }
    };
    compare('total_supply_vs_ledger_circulating', new Prisma.Decimal(snapshot.totalSupply), ledgerCirculating);
    compare('treasury_balance_vs_ledger_available', new Prisma.Decimal(snapshot.treasuryBalance), treasuryAvailable === null ? null : new Prisma.Decimal(treasuryAvailable));
    compare('minted_events_vs_confirmed_mint_requests', mintedEventsTotal, confirmedMintRequestsTotal);
    compare('on_chain_total_supply_vs_minted_events', new Prisma.Decimal(snapshot.totalSupply), mintedEventsTotal);

    return {
      onChain: {
        totalSupply: snapshot.totalSupply,
        maxSupply: snapshot.maxSupply,
        treasuryBalance: snapshot.treasuryBalance,
        mintedEventsTotal: mintedEventsTotal.toFixed(18),
        burnedEventsTotal: burnedEventsTotal.toFixed(18),
      },
      offChain: {
        ledgerIssuedSupply: ledgerIssued.toFixed(18),
        ledgerBurnedSupply: ledgerBurned.toFixed(18),
        ledgerCirculatingSupply: ledgerCirculating.toFixed(18),
        treasuryAvailableEmber: treasuryAvailable,
        confirmedMintRequestsTotal: confirmedMintRequestsTotal.toFixed(18),
        seedAndDemoIssuedEstimate: seedAndDemoIssuedEstimate.toFixed(18),
        confirmedMintsWithMissingEvent,
        unconfirmedMintRequests,
      },
      differences,
    };
  }

  private async audit(actorUserId: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: { actorUserId, action, detail: detail as Prisma.InputJsonValue },
      });
    } catch (error) {
      this.logger.warn(`Audit logging for ${action} failed: ${shortErrorText(error)}`);
    }
  }
}
