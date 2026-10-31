import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  Prisma,
  TokenBuybackStatus,
  TokenBurnSource,
  TransactionType,
  type Asset,
  type TokenAllocation,
  type TokenBuyback,
  type TokenBurn,
} from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { TreasuryReserveGuard } from '../treasury/treasury-reserve.guard';
import { WalletService } from '../wallet/wallet.service';
import {
  computeAllocation,
  emberQuantity,
  parseEmberAmount,
  parseEmberPrice,
  type AllocationComputation,
} from './domain/allocation-math';
import { AdaptiveBurnPolicyService } from './adaptive-burn-policy.service';
import type { CreateAllocationDto } from './dto/create-allocation.dto';
import type { CreateBuybackDto } from './dto/create-buyback.dto';
import type { CreateBurnDto } from './dto/create-burn.dto';
import type { ExecuteBuybackDto } from './dto/execute-buyback.dto';
import type { PreviewAllocationDto } from './dto/preview-allocation.dto';

/**
 * MODULE 11 — EMBER tokenomics: allocation, simulated buyback, real burns.
 *
 * THREE RECORD TYPES, ONLY ONE OF WHICH MOVES MONEY:
 *
 *  1. ALLOCATIONS split a caller-stated reference amount by the configured
 *     percentages (default 60/40, boot-validated to sum to 100). Immutable
 *     proposals: they move nothing and change no supply figure. Arithmetic
 *     lives in `domain/allocation-math.ts` so the rounding policy is one
 *     tested implementation shared with the read-only preview endpoint.
 *
 *  2. BUYBACKS walk SIMULATED -> RECORDED_SIMULATED_EXECUTION. Both stages
 *     move nothing: the architecture has no price venue, no buyback funding
 *     and no settlement record, so there is deliberately no actual-execution
 *     state and no column that could be read as one. The status transition is
 *     one-way and guarded (`UPDATE ... WHERE status = SIMULATED`), which IS
 *     the execute endpoint's idempotency - a replay of the same price returns
 *     the record, a different price for a recorded execution is 409.
 *
 *  3. BURNS destroy EMBER. One database transaction: debit the TREASURY
 *     wallet's available balance with a `TransactionType.BURN` ledger leg
 *     through `WalletService` (Module 03's boundary - this module never
 *     writes the ledger tables itself), then insert the `token_burns` row.
 *     All or nothing, so a burn row exists if and only if the destruction
 *     committed. Supply's `burnedSupply` is SUM(BURN) over the ledger
 *     (Module 10 reads it), which reconciles 1:1 with this table.
 *
 * TREASURY is the system user `treasury@prometheus.local`, auto-provisioned
 * on first burn exactly as Module 09 auto-registers LPs (no seed step, no
 * API surface). It is funded only through service-level credits in seeds and
 * tests - there is no minting route, so an unfunded treasury simply refuses
 * burns with 409 INSUFFICIENT_BALANCE. Locking is not a burn: locked EMBER
 * sits in the locked column and cannot fund one, because `debit` only ever
 * draws on available.
 *
 * IDEMPOTENCY is a key per record type: `(userId, clientRequestId)` unique on
 * each table. A replay finds the original, verifies the payload still
 * describes the same request, and returns it without writing anything; the
 * same key with a different payload is 409 CONFLICT. Two constraints go
 * further and hold globally: one buyback per allocation, one burn per
 * buyback - together they make double-proposing and double-burning
 * impossible even across different callers.
 *
 * RBAC: the mutation routes (allocations, buybacks, executions, burns) are
 * PLATFORM_ADMIN-gated at the controller (prompt §9's owner-approved change);
 * reads stay available to every authenticated caller, and records remain
 * scoped to their creator. Ownership is enforced against other callers' ids
 * (404, not 403, matching Module 05's posture so an id cannot be probed).
 *
 * NOT HERE, by scope: actual buyback execution, treasury funding or
 * guardrails, working-capital rules, staking, rewards, minting, and any
 * price feed - the prices in this module are caller-supplied illustrations
 * and are labelled as such wherever they are shown.
 */
@Injectable()
export class TokenomicsService {
  /** The system account every burn draws from. */
  private static readonly TREASURY_EMAIL = 'treasury@prometheus.local';

  /** Newest entries per record type returned by `records()`. */
  private static readonly RECORDS_LIMIT = 50;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly reserveGuard: TreasuryReserveGuard,
    /**
     * An OPTIONAL provider (Module 8's adaptive burn policy) that overrides
     * the configured 60/40 baseline split per allocation. Absent it in unit
     * tests and other deployments, the split is exactly the configured
     * baseline; present, the recalculation is the current treasury-health
     * policy decision. The blockchain service hook, also optional, is what
     * carries every recorded burn to the chain AFTER its commit - a disabled
     * layer stays silently NOT_REQUIRED.
     */
    @Optional() @Inject(AdaptiveBurnPolicyService) private readonly burnPolicyProvider?: AdaptiveBurnPolicyService,
    @Optional() @Inject(BlockchainService) private readonly blockchainService?: BlockchainService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The configured allocation split, as boot-validated. */
  configSummary(): { directBurnPct: number; buybackPct: number } {
    return {
      directBurnPct: this.config.tokenomics.directBurnPct,
      buybackPct: this.config.tokenomics.buybackPct,
    };
  }

  /**
   * Computes an allocation without recording it.
   *
   * Same function as `createAllocation`, so a preview can never disagree with
   * the record it would create - and nothing is written, because only burns
   * change supply. The split is the adaptive policy decision when the
   * provider is wired into the module, the configured baseline otherwise.
   */
  async preview(dto: PreviewAllocationDto): Promise<AllocationComputation> {
    const split = await this.allocationSplit();
    return computeAllocation(dto.referenceAmount, dto.emberPrice, split.directBurnPct, split.buybackPct);
  }

  /** The caller's own records, newest first, bounded per type. */
  async records(userId: string): Promise<{
    allocations: TokenAllocation[];
    buybacks: (TokenBuyback & { allocation: TokenAllocation })[];
    burns: TokenBurn[];
  }> {
    const take = TokenomicsService.RECORDS_LIMIT;

    const [allocations, buybacks, burns] = await Promise.all([
      this.prisma.tokenAllocation.findMany({
        where: { userId },
        orderBy: { allocatedAt: 'desc' },
        take,
      }),
      this.prisma.tokenBuyback.findMany({
        where: { userId },
        orderBy: { simulatedAt: 'desc' },
        take,
        include: { allocation: true },
      }),
      this.prisma.tokenBurn.findMany({
        where: { userId },
        orderBy: { burnedAt: 'desc' },
        take,
      }),
    ]);

    return { allocations, buybacks, burns };
  }

  // ---------------------------------------------------------------------------
  // Allocations
  // ---------------------------------------------------------------------------

  /**
   * Records an allocation proposal, or returns the original on a replay.
   *
   * A single insert - no balances are touched anywhere on this path, which is
   * also what the buyback and burn paths depend on: only a burn can ever
   * reach `WalletService.debit`.
   */
  async createAllocation(
    userId: string,
    dto: CreateAllocationDto,
  ): Promise<{ allocation: TokenAllocation; created: boolean }> {
    const split = await this.allocationSplit();
    const computation = computeAllocation(
      dto.referenceAmount,
      dto.emberPrice,
      split.directBurnPct,
      split.buybackPct,
    );

    const replay = await this.findAllocationReplay(userId, dto.clientRequestId);
    if (replay) {
      this.assertAllocationReplay(replay, computation);
      return { allocation: replay, created: false };
    }

    try {
      const allocation = await this.prisma.tokenAllocation.create({
        data: {
          userId,
          referenceAmount: computation.referenceAmount,
          emberPrice: computation.emberPrice,
          directBurnPct: computation.directBurnPct,
          buybackPct: computation.buybackPct,
          directBurnInr: computation.directBurnInr,
          buybackInr: computation.buybackInr,
          directBurnEmber: computation.directBurnEmber,
          buybackEmber: computation.buybackEmber,
          clientRequestId: dto.clientRequestId,
        },
      });
      return { allocation, created: true };
    } catch (error) {
      // A concurrent request with the same key won the insert; its row is the
      // truth - unless its payload differs, which is a conflict.
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.findAllocationReplay(userId, dto.clientRequestId);
        if (winner) {
          this.assertAllocationReplay(winner, computation);
          return { allocation: winner, created: false };
        }
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Simulated buybacks
  // ---------------------------------------------------------------------------

  /**
   * Proposes a simulated buyback against a recorded allocation, or returns
   * the original on a replay. Moves nothing: the allocation's buyback portion
   * already carries every figure this record needs.
   */
  async createBuyback(
    userId: string,
    dto: CreateBuybackDto,
  ): Promise<{ buyback: TokenBuyback & { allocation: TokenAllocation }; created: boolean }> {
    const allocation = await this.loadOwnedAllocation(dto.allocationId, userId);

    const replay = await this.findBuybackReplay(userId, dto.clientRequestId);
    if (replay) {
      this.assertBuybackReplay(replay, dto.allocationId);
      return { buyback: replay, created: false };
    }

    try {
      const buyback = await this.prisma.tokenBuyback.create({
        data: { allocationId: allocation.allocationId, userId, clientRequestId: dto.clientRequestId },
        include: { allocation: true },
      });
      return { buyback, created: true };
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.findBuybackReplay(userId, dto.clientRequestId);
        if (winner) {
          this.assertBuybackReplay(winner, dto.allocationId);
          return { buyback: winner, created: false };
        }
        // The key is unused, so the loser raced a DIFFERENT request already
        // holding this allocation: one buyback per allocation, by database
        // constraint rather than by hopeful application logic.
        throw DomainException.conflict(
          'This allocation already has a buyback. One simulated buyback per allocation.',
        );
      }
      throw error;
    }
  }

  /**
   * Records a simulated execution against a buyback, or replays one.
   *
   * The guarded one-way update is the whole idempotency story: exactly one
   * request can move SIMULATED -> RECORDED_SIMULATED_EXECUTION, losers of the
   * race re-read and then either match (200 replay) or name a different price
   * (409). Quantity is derived from the allocation's buyback portion at the
   * supplied price, floored to 18dp - never caller-stated - and still moves
   * nothing.
   */
  async executeBuyback(
    userId: string,
    buybackId: string,
    dto: ExecuteBuybackDto,
  ): Promise<{ buyback: TokenBuyback & { allocation: TokenAllocation }; created: boolean }> {
    const existing = await this.loadOwnedBuyback(buybackId, userId);

    if (existing.status === TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION) {
      return this.replayOrConflictExecution(existing, dto);
    }

    const executedPrice = parseEmberPrice(dto.executedPrice);
    const executedEmber = emberQuantity(existing.allocation.buybackInr, executedPrice);

    if (executedEmber.lte(0)) {
      throw DomainException.badRequest(
        'The buyback portion funds less than one atto-EMBER at this price, so the executed quantity would be zero. Refused rather than recording a burnable quantity of nothing.',
      );
    }

    const updated = await this.prisma.tokenBuyback.updateMany({
      where: { buybackId, status: TokenBuybackStatus.SIMULATED },
      data: {
        status: TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION,
        executedPrice,
        executedEmber,
        executedAt: new Date(),
      },
    });

    if (updated.count === 1) {
      return { buyback: await this.loadBuyback(buybackId), created: true };
    }

    // Someone else recorded first. Their execution is the truth: match it or
    // refuse, never overwrite.
    const winner = await this.loadOwnedBuyback(buybackId, userId);
    return this.replayOrConflictExecution(winner, dto);
  }

  // ---------------------------------------------------------------------------
  // Burns
  // ---------------------------------------------------------------------------

  /**
   * Records a burn: debits the treasury's available EMBER with a BURN ledger
   * leg and inserts the record, in one transaction.
   *
   * DIRECT requires `amount`; BUYBACK requires an owned `buybackId` that has
   * a recorded simulated execution and has never been burned (uniqueness
   * enforced by the database). Both paths validate before opening the
   * transaction, so a refused burn writes nothing at all. Inside the
   * transaction, Module 12's reserve guard refuses (with nothing written)
   * any burn that would take the treasury below its approved protected floor.
   */
  async createBurn(
    userId: string,
    dto: CreateBurnDto,
  ): Promise<{ burn: TokenBurn; created: boolean }> {
    const { source, buybackId, amount } = await this.resolveBurnIntent(userId, dto);

    const emberAsset = await this.requireAsset('EMBER');

    const replay = await this.findBurnReplay(userId, dto.clientRequestId);
    if (replay) {
      this.assertBurnReplay(replay, { source, buybackId, amount });
      return { burn: replay, created: false };
    }

    if (buybackId) {
      // After the replay check (so this caller's own key still replays 200)
      // and before the treasury debit (so a state conflict is never masked by
      // insufficient balance); the insert's unique constraint still guards
      // the concurrent double-burn race.
      const priorBurn = await this.prisma.tokenBurn.findUnique({ where: { buybackId } });
      if (priorBurn) {
        throw DomainException.conflict(
          'This buyback has already been burned. One burn per recorded execution.',
        );
      }
    }

    const treasury = await this.ensureTreasury();
    const burnId = randomUUID();

    try {
      const burn = await this.prisma.$transaction(async (tx) => {
        // Module 12's reserve check, in this same transaction and under the
        // advisory lock the guard takes: a discretionary burn that would take
        // the treasury below its approved 30% floor is refused here, before
        // any ledger leg or record can exist. INSUFFICIENT_BALANCE still
        // wins when the balance cannot cover the amount at all - the guard
        // defers to the debit for that.
        await this.reserveGuard.assertDiscretionaryEmberDebit(tx, {
          walletId: treasury.walletId,
          assetId: emberAsset.id,
          amount,
        });

        // Legs first, then the record - the same order every Module 03-based
        // writer uses: a concurrent duplicate reaches the insert, loses the
        // unique race, and rolls its debit back with it.
        await this.walletService.debit(
          treasury.walletId,
          emberAsset.id,
          amount,
          { type: TransactionType.BURN, note: `EMBER burn ${burnId}` },
          tx,
        );

        return tx.tokenBurn.create({
          data: {
            burnId,
            userId,
            source,
            buybackId,
            amount,
            clientRequestId: dto.clientRequestId,
          },
        });
      });

      // The ledger side is final here: offer it to the chain after this
      // response commits. The hook never throws and never rolls back a burn -
      // a failed propagation leaves the burn exactly as correct as before,
      // its row merely carrying an onChainStatus an operator can act on.
      await this.blockchainService?.submitBurnForLedgerBurn(burn.burnId, burn.amount.toFixed(18), userId);

      return { burn, created: true };
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.findBurnReplay(userId, dto.clientRequestId);
        if (winner) {
          this.assertBurnReplay(winner, { source, buybackId, amount });
          return { burn: winner, created: false };
        }
        // The key is unused: a different caller already burned this buyback.
        throw DomainException.conflict(
          'This buyback has already been burned. One burn per recorded execution.',
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals - validation and lookup
  // ---------------------------------------------------------------------------

  /**
   * The split for allocations and previews. The baseline configured values
   * exist even without the adaptive provider (which every unit test relies
   * on); with the provider wired, the treasury-health ramp decides.
   */
  private async allocationSplit(): Promise<{ directBurnPct: number; buybackPct: number }> {
    if (this.burnPolicyProvider) {
      const decision = await this.burnPolicyProvider.resolveSplit();
      return { directBurnPct: decision.directBurnPct, buybackPct: decision.buybackPct };
    }
    return {
      directBurnPct: this.config.tokenomics.directBurnPct,
      buybackPct: this.config.tokenomics.buybackPct,
    };
  }

  /**
   * Validates a burn request into the intent it will execute: the source,
   * the optional buyback link, and the exact EMBER amount.
   *
   * The two sources are deliberately not interchangeable inputs: a DIRECT
   * burn states its own amount and names no buyback; a BUYBACK burn names an
   * executed buyback and takes its quantity exactly - accepting both would
   * allow a burn to disagree with the record it claims to be.
   */
  private async resolveBurnIntent(
    userId: string,
    dto: CreateBurnDto,
  ): Promise<{ source: TokenBurnSource; buybackId: string | null; amount: Prisma.Decimal }> {
    if (dto.source === 'DIRECT') {
      if (dto.buybackId !== undefined) {
        throw DomainException.badRequest(
          'buybackId must not be set for a DIRECT burn; it names a buyback this burn is not linked to.',
        );
      }
      if (dto.amount === undefined) {
        throw DomainException.badRequest('amount is required for a DIRECT burn.');
      }
      return {
        source: TokenBurnSource.DIRECT,
        buybackId: null,
        amount: parseEmberAmount(dto.amount),
      };
    }

    if (dto.buybackId === undefined) {
      throw DomainException.badRequest(
        'buybackId is required for a BUYBACK burn; the amount is the executed quantity of that buyback.',
      );
    }
    if (dto.amount !== undefined) {
      throw DomainException.badRequest(
        'amount must not be set for a BUYBACK burn; the burned quantity is exactly the executed quantity of that buyback.',
      );
    }

    const buyback = await this.loadOwnedBuyback(dto.buybackId, userId);

    if (buyback.status !== TokenBuybackStatus.RECORDED_SIMULATED_EXECUTION) {
      throw DomainException.conflict(
        'This buyback has no recorded simulated execution yet. Record the execution before burning it.',
      );
    }
    if (buyback.executedEmber === null) {
      // Unreachable while status and the columns are written together; kept
      // as a refusal rather than a crash if the two ever drift.
      throw DomainException.conflict('This buyback is marked executed but carries no executed quantity.');
    }

    return {
      source: TokenBurnSource.BUYBACK,
      buybackId: buyback.buybackId,
      amount: buyback.executedEmber,
    };
  }

  /**
   * An allocation id that does not exist and one that belongs to somebody
   * else are both 404, so the id cannot be probed - Module 05's posture.
   */
  private async loadOwnedAllocation(
    allocationId: string,
    userId: string,
  ): Promise<TokenAllocation> {
    const allocation = await this.prisma.tokenAllocation.findUnique({ where: { allocationId } });
    if (!allocation || allocation.userId !== userId) {
      throw DomainException.notFound('Allocation');
    }
    return allocation;
  }

  /** Owned buyback with its immutable allocation joined, or 404 for both. */
  private async loadOwnedBuyback(
    buybackId: string,
    userId: string,
  ): Promise<TokenBuyback & { allocation: TokenAllocation }> {
    const buyback = await this.prisma.tokenBuyback.findUnique({
      where: { buybackId },
      include: { allocation: true },
    });
    if (!buyback || buyback.userId !== userId) {
      throw DomainException.notFound('Buyback');
    }
    return buyback;
  }

  private loadBuyback(buybackId: string): Promise<TokenBuyback & { allocation: TokenAllocation }> {
    return this.prisma.tokenBuyback.findUniqueOrThrow({
      where: { buybackId },
      include: { allocation: true },
    });
  }

  /**
   * The treasury user and wallet every burn debits.
   *
   * Auto-provisioned on first burn (the Module 09 auto-register pattern), so
   * there is no seed step to remember and no HTTP surface that could create
   * or fund it. The unique email is the race arbiter: two concurrent first
   * burns both try to create, the loser reads the winner's row.
   */
  private async ensureTreasury(): Promise<{ userId: string; walletId: string }> {
    const email = TokenomicsService.TREASURY_EMAIL;
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });

    let userId = existing?.id;
    if (!userId) {
      try {
        userId = (await this.prisma.user.create({ data: { email } })).id;
      } catch (error) {
        if (!this.isUniqueConstraintViolation(error)) throw error;
        userId = (await this.prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
      }
    }

    const { wallet } = await this.walletService.getOrCreateForUser(userId);
    return { userId, walletId: wallet.id };
  }

  /** Reference data must be present and active before anything moves against it. */
  private async requireAsset(symbol: string): Promise<Asset> {
    const asset = await this.prisma.asset.findUnique({ where: { symbol } });

    if (!asset) {
      throw DomainException.notFound('Asset', symbol);
    }
    if (!asset.isActive) {
      throw DomainException.assetInactive(asset.symbol);
    }

    return asset;
  }

  // ---------------------------------------------------------------------------
  // Internals - idempotent replays
  // ---------------------------------------------------------------------------

  private findAllocationReplay(
    userId: string,
    clientRequestId: string,
  ): Promise<TokenAllocation | null> {
    return this.prisma.tokenAllocation.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
    });
  }

  /**
   * A replayed key must describe the allocation that already happened: same
   * reference amount and same price. Same inputs recompute to the same
   * figures (percentages are snapshot columns on the stored row), so the two
   * compared inputs are the whole payload.
   */
  private assertAllocationReplay(stored: TokenAllocation, computation: AllocationComputation): void {
    const sameAmount = stored.referenceAmount.eq(computation.referenceAmount);
    const samePrice = stored.emberPrice.eq(computation.emberPrice);

    if (!sameAmount || !samePrice) {
      throw DomainException.conflict(
        'clientRequestId was already used for a different allocation. Reuse one idempotency key per unique request.',
      );
    }
  }

  private findBuybackReplay(
    userId: string,
    clientRequestId: string,
  ): Promise<(TokenBuyback & { allocation: TokenAllocation }) | null> {
    return this.prisma.tokenBuyback.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
      include: { allocation: true },
    });
  }

  private assertBuybackReplay(stored: TokenBuyback, allocationId: string): void {
    if (stored.allocationId !== allocationId) {
      throw DomainException.conflict(
        'clientRequestId was already used for a different buyback. Reuse one idempotency key per unique request.',
      );
    }
  }

  private findBurnReplay(userId: string, clientRequestId: string): Promise<TokenBurn | null> {
    return this.prisma.tokenBurn.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
    });
  }

  /**
   * The payload that must still match on a burn replay. A burn's outcome is
   * (source, buyback link, amount): for a BUYBACK burn the amount is derived
   * from the referenced execution, so a changed price upstream would show up
   * here as a different amount - correctly refused rather than silently
   * replaying a burn of a different size.
   */
  private assertBurnReplay(
    stored: TokenBurn,
    intent: { source: TokenBurnSource; buybackId: string | null; amount: Prisma.Decimal },
  ): void {
    const sameSource = stored.source === intent.source;
    const sameBuyback = stored.buybackId === intent.buybackId;
    const sameAmount = stored.amount.eq(intent.amount);

    if (!sameSource || !sameBuyback || !sameAmount) {
      throw DomainException.conflict(
        'clientRequestId was already used for a different burn. Reuse one idempotency key per unique request.',
      );
    }
  }

  /** Execution replay: the stored execution is returned, or refused if it differs. */
  private replayOrConflictExecution(
    stored: TokenBuyback & { allocation: TokenAllocation },
    dto: ExecuteBuybackDto,
  ): { buyback: TokenBuyback & { allocation: TokenAllocation }; created: boolean } {
    const requestedPrice = parseEmberPrice(dto.executedPrice);
    const samePrice = stored.executedPrice !== null && stored.executedPrice.eq(requestedPrice);

    if (samePrice) {
      return { buyback: stored, created: false };
    }

    throw DomainException.conflict(
      'This buyback already has a simulated execution recorded at a different price. An execution is one-way.',
    );
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
