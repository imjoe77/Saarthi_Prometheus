import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma, TransactionType, type Asset, type EmberTransfer } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';
import { normaliseAmount } from '../wallet/decimal.util';
import { WalletService } from '../wallet/wallet.service';
import type { CreateEmberTransferDto } from './dto/create-ember-transfer.dto';

/**
 * MODULE 10 — EMBER token accounting.
 *
 * Two responsibilities, both built on Module 03's accounting boundary:
 *
 *  1. USER-TO-USER EMBER TRANSFERS. A transfer is one database transaction:
 *     insert the `ember_transfers` row (claiming the idempotency key), debit
 *     the sender with TRANSFER_OUT, credit the recipient with TRANSFER_IN.
 *     All three commit or none do. `WalletService.debit` refuses unless the
 *     sender's AVAILABLE balance covers the amount, so locked EMBER - which
 *     lives in the locked column - is unspendable by construction; there is
 *     no second balance check to keep in sync and no parallel ledger.
 *
 *     IDEMPOTENCY IS A KEY, NOT A FLAG - `(senderUserId, clientRequestId)` is
 *     unique. A replay finds the original row, verifies the payload still
 *     matches (same recipient, same amount), and returns it without touching
 *     a balance; the same key with a different payload is 409 CONFLICT. Two
 *     racing requests with the same key both start, and the loser's insert
 *     fails with a unique violation that rolls its whole transaction back -
 *     legs and row together - so the balances apply exactly once across both.
 *
 *  2. LEDGER-DERIVED SUPPLY METRICS (GET /ember/supply). Every figure is
 *     aggregated from `transactions` and `wallet_balances`; there is no
 *     supply table and nothing is invented:
 *       - totalIssued  = SUM(DEPOSIT) - SUM(WITHDRAWAL) for EMBER. The
 *         transaction vocabulary makes this exact: TRANSFER_IN/OUT net to
 *         zero across wallets and LOCK/UNLOCK only move value between the
 *         two columns of one balance, so neither issues nor destroys.
 *       - burned       = SUM(BURN) for EMBER. BURN is the ledger leg
 *         Module 11 writes when a burn record commits (the two are written
 *         in one transaction, so they cannot diverge); with no burn rows
 *         recorded the figure is zero. Nothing else in the vocabulary
 *         destroys EMBER.
 *       - circulating  = totalIssued - burned.
 *       - locked       = SUM(locked) over wallet_balances (includes Module
 *         09 LP commitment locks).
 *       - available    = SUM(available) over wallet_balances.
 *
 *     LIMITATION, stated rather than hidden: ADJUSTMENT rows carry a positive
 *     magnitude with direction implied by the surrounding balance chain, so
 *     the ledger cannot classify an adjustment as issuance or destruction
 *     from the row alone. No code path creates EMBER adjustments today; if
 *     one ever appears, the issued figure must be revisited before this
 *     endpoint is trusted. Transfers and locks are NOT issuance or burns and
 *     are excluded by construction.
 *
 * NOT HERE, by scope: staking, APY, rewards, minting, and any public
 * lock/unlock endpoint. Burning (and the treasury every burn debits) belongs
 * to Module 11; this module only reports its ledger effect above. Locking
 * remains Module 09's internal WalletService path; this module only respects
 * it (debits cannot spend locked value) and reports it (lockedSupply
 * includes LP locks).
 */
@Injectable()
export class EmberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Moves EMBER from the sender to the recipient, or returns the original
   * transfer on an idempotent replay.
   */
  async transfer(senderUserId: string, dto: CreateEmberTransferDto): Promise<{
    transfer: EmberTransfer;
    created: boolean;
  }> {
    const emberAsset = await this.requireAsset('EMBER');
    const amount = normaliseAmount(dto.amount, emberAsset);

    const replay = await this.findReplay(senderUserId, dto.clientRequestId);
    if (replay) {
      // Resolve the recipient for the comparison even on a replay, so a
      // reused key that now names a different recipient is a conflict.
      const recipient = await this.resolveRecipient(dto.recipientEmail);
      this.assertReplayPayload(replay, recipient.id, amount);
      return { transfer: replay, created: false };
    }

    const recipient = await this.resolveRecipient(dto.recipientEmail);

    if (recipient.id === senderUserId) {
      throw DomainException.badRequest('Cannot transfer EMBER to yourself.');
    }

    const senderWallet = await this.walletService.getForUserOrThrow(senderUserId);
    // Receiving provisions the recipient's wallet lazily, exactly as Module 03
    // provisions the caller's own wallet on first use. A frozen wallet is
    // refused inside the transaction by WalletService, rolling both legs back.
    const { wallet: recipientWallet } = await this.walletService.getOrCreateForUser(recipient.id);

    const transferId = randomUUID();
    const note = `EMBER transfer ${transferId}`;

    try {
      const transfer = await this.prisma.$transaction(async (tx) => {
        // Legs first, then the idempotency row - the same order Module 08's
        // exchange uses. A concurrent duplicate reaches the insert, loses the
        // unique race, and rolls its legs back with the row.
        await this.walletService.debit(
          senderWallet.id,
          emberAsset.id,
          amount,
          { type: TransactionType.TRANSFER_OUT, note },
          tx,
        );
        await this.walletService.credit(
          recipientWallet.id,
          emberAsset.id,
          amount,
          { type: TransactionType.TRANSFER_IN, note },
          tx,
        );

        return tx.emberTransfer.create({
          data: {
            transferId,
            senderUserId,
            recipientUserId: recipient.id,
            amount,
            clientRequestId: dto.clientRequestId,
          },
        });
      });

      return { transfer, created: true };
    } catch (error) {
      // A concurrent request with the same key won the insert; its transaction
      // committed the balances, ours rolled back, and the original is the
      // truth - unless its payload differs, which is a conflict.
      if (this.isUniqueConstraintViolation(error)) {
        const winner = await this.findReplay(senderUserId, dto.clientRequestId);
        if (winner) {
          this.assertReplayPayload(winner, recipient.id, amount);
          return { transfer: winner, created: false };
        }
      }

      throw error;
    }
  }

  /**
   * Ledger-derived EMBER supply figures. Read-only: one ledger aggregation,
   * one balance aggregation, nothing written.
   */
  async supply(): Promise<{
    totalIssued: Prisma.Decimal;
    circulating: Prisma.Decimal;
    locked: Prisma.Decimal;
    available: Prisma.Decimal;
    burned: Prisma.Decimal;
  }> {
    const emberAsset = await this.requireAsset('EMBER');

    const [movements, balances] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { assetId: emberAsset.id },
        _sum: { amount: true },
      }),
      this.prisma.walletBalance.aggregate({
        where: { assetId: emberAsset.id },
        _sum: { available: true, locked: true },
      }),
    ]);

    const sumByType = new Map(
      movements.map((row) => [row.type, row._sum.amount ?? new Prisma.Decimal(0)]),
    );

    const deposited = sumByType.get(TransactionType.DEPOSIT) ?? new Prisma.Decimal(0);
    const withdrawn = sumByType.get(TransactionType.WITHDRAWAL) ?? new Prisma.Decimal(0);
    const totalIssued = deposited.minus(withdrawn);

    // Destroyed EMBER, summed from the ledger: each Module 11 burn writes
    // exactly one BURN leg of the same amount in the same transaction as its
    // record, so this figure counts every burn exactly once. Zero while no
    // burn rows exist - nothing is assumed, nothing is stored.
    const burned = sumByType.get(TransactionType.BURN) ?? new Prisma.Decimal(0);
    const circulating = totalIssued.minus(burned);
    const locked = balances._sum.locked ?? new Prisma.Decimal(0);
    const available = balances._sum.available ?? new Prisma.Decimal(0);

    return { totalIssued, circulating, locked, available, burned };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private findReplay(senderUserId: string, clientRequestId: string): Promise<EmberTransfer | null> {
    return this.prisma.emberTransfer.findUnique({
      where: { senderUserId_clientRequestId: { senderUserId, clientRequestId } },
    });
  }

  /**
   * A replayed key must describe the transfer that already happened. Same
   * recipient and same amount is the same request returning the original;
   * anything else is a client bug and is refused rather than silently
   * returning a transfer the caller did not make this time.
   */
  private assertReplayPayload(
    stored: EmberTransfer,
    recipientUserId: string,
    amount: Prisma.Decimal,
  ): void {
    const sameRecipient = stored.recipientUserId === recipientUserId;
    const sameAmount = stored.amount.eq(amount);

    if (!sameRecipient || !sameAmount) {
      throw DomainException.conflict(
        'clientRequestId was already used for a different transfer. Reuse one idempotency key per unique request.',
      );
    }
  }

  /** Recipients are named by their registered email: unique on `users`. */
  private async resolveRecipient(email: string): Promise<{ id: string }> {
    // Emails are stored lowercased by the auth path (auth.service.ts), so the
    // lookup normalises the same way or a mixed-case address would miss an
    // account that exists.
    const recipient = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true },
    });

    if (!recipient) {
      throw DomainException.notFound('Recipient');
    }

    return recipient;
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

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
