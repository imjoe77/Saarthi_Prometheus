import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import {
  clearTestLiquidityEnv,
  configureTestLiquidityEnv,
  resetLiquidityTables,
} from './liquidity-test-fixture';
import { mintToken } from './token-minting';

/**
 * MODULE 10 - EMBER token accounting over HTTP.
 *
 * Boots the real application against the real database, the same way Module 03's
 * wallet suite does. The guarantees this module claims - that a transfer either
 * moves both legs or neither, that a replayed idempotency key returns the
 * original instead of spending twice, that a racing duplicate settles exactly
 * once, that locked EMBER is unspendable, and that supply figures are derived
 * from the ledger rather than stored - only exist in the database, so a suite
 * against a mock would prove nothing.
 *
 * Isolation: every user carries a UUID in its email and is purged in afterAll
 * (ledger rows, then balances, then ember_transfers, then wallets, then users -
 * the schema Restricts to protect financial history). Module 09 tables are
 * reset because the supply test registers a real liquidity commitment to prove
 * LP locks are included in lockedSupply and respected by transfers.
 *
 * Supply assertions are DELTAS, not absolute values: the database is shared
 * with every other suite, so only the change caused by this suite's own
 * operations is well-defined.
 */
describe('EMBER transfers and supply (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];
  const assetIdBySymbol = new Map<string, string>();

  interface TransferPayload {
    transferId: string;
    amount: string;
    transferredAt: string;
  }

  interface SupplyPayload {
    asset: string;
    totalIssuedSupply: string;
    circulatingSupply: string;
    lockedSupply: string;
    availableSupply: string;
    burnedSupply: string;
  }

  beforeAll(async () => {
    // The Module 09 integration test registers a real commitment through the
    // real API; the fixture slabs match the approved production table exactly.
    configureTestLiquidityEnv();

    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
    walletService = app.get(WalletService);

    await seedAssets(prisma);
    await resetLiquidityTables(prisma);

    for (const symbol of ['INR', 'USDT', 'EMBER']) {
      const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol } });
      assetIdBySymbol.set(symbol, asset.id);
    }
  });

  afterAll(async () => {
    await resetLiquidityTables(prisma);

    if (createdUserIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.emberTransfer.deleteMany({
        where: {
          OR: [{ senderUserId: { in: createdUserIds } }, { recipientUserId: { in: createdUserIds } }],
        },
      });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    clearTestLiquidityEnv();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const emberId = () => assetIdBySymbol.get('EMBER') as string;

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(
    label: string,
    emailOverride?: string,
  ): Promise<{ token: string; userId: string; email: string }> {
    const email = (emailOverride ?? `${label}-${randomUUID()}@ember.test`).toLowerCase();

    const token = await mintToken({
      subject: `google:${label}-${randomUUID()}`,
      email,
    });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id, email: response.body.email as string };
  }

  async function createUserWithWallet(label: string): Promise<{ token: string; userId: string; email: string }> {
    const user = await createUser(label);
    await http().post('/api/wallets').set(bearer(user.token)).expect(201);
    return user;
  }

  async function fund(userId: string, amount: string): Promise<void> {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    await walletService.credit(wallet.id, emberId(), amount);
  }

  async function balancesOf(userId: string): Promise<{ available: string; locked: string }> {
    // A user who never created a wallet holds nothing; recipients are only
    // provisioned lazily on their first received transfer.
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      return { available: '0.000000000000000000', locked: '0.000000000000000000' };
    }

    const balance = await prisma.walletBalance.findUnique({
      where: {
        walletId_assetId: {
          walletId: wallet.id,
          assetId: emberId(),
        },
      },
    });

    return {
      available: (balance?.available ?? new Prisma.Decimal(0)).toFixed(18),
      locked: (balance?.locked ?? new Prisma.Decimal(0)).toFixed(18),
    };
  }

  async function supply(): Promise<SupplyPayload> {
    const response = await http().get('/api/ember/supply').set(bearer(minted.token)).expect(200);
    return response.body as SupplyPayload;
  }

  const minted = { token: '' };

  const transfer = (
    token: string,
    body: { recipientEmail: string; amount: string; clientRequestId?: string },
  ) => http().post('/api/ember/transfers').set(bearer(token)).send({ ...body, clientRequestId: body.clientRequestId ?? randomUUID() });

  async function transferCountFor(senderUserId: string): Promise<number> {
    return prisma.emberTransfer.count({ where: { senderUserId } });
  }

  beforeAll(async () => {
    minted.token = (await mintToken({ subject: `google:supply-reader-${randomUUID()}`, email: `supply-reader-${randomUUID()}@ember.test` }));
  });

  // -------------------------------------------------------------------------
  // Authentication and validation
  // -------------------------------------------------------------------------

  describe('authentication and request validation', () => {
    it.each([
      ['POST', '/api/ember/transfers'],
      ['GET', '/api/ember/supply'],
    ] as const)('refuses %s %s without a token', async (method, path) => {
      await http()[method.toLowerCase() as 'get' | 'post'](path).expect(401);
    });

    it('refuses a body missing the recipient, a non-email recipient, a non-string amount and a non-UUID key', async () => {
      const { token } = await createUser('validation');

      const missingRecipient = await transfer(token, { recipientEmail: '', amount: '1' }).expect(400);
      expect(missingRecipient.body.code).toBe('VALIDATION_FAILED');

      const notAnEmail = await transfer(token, { recipientEmail: 'not-an-email', amount: '1' }).expect(400);
      expect(notAnEmail.body.code).toBe('VALIDATION_FAILED');

      const numericAmount = await http()
        .post('/api/ember/transfers')
        .set(bearer(token))
        .send({ recipientEmail: 'anyone@example.com', amount: 5, clientRequestId: randomUUID() })
        .expect(400);
      expect(numericAmount.body.code).toBe('VALIDATION_FAILED');

      const notAUuid = await transfer(token, {
        recipientEmail: 'anyone@example.com',
        amount: '1',
        clientRequestId: 'not-a-uuid',
      }).expect(400);
      expect(notAUuid.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses an unknown recipient with 404 NOT_FOUND and moves nothing', async () => {
      const sender = await createUserWithWallet('unknown-recipient');
      await fund(sender.userId, '100');

      await transfer(sender.token, {
        recipientEmail: `ghost-${randomUUID()}@ember.test`,
        amount: '10',
      }).expect(404);

      expect(await balancesOf(sender.userId)).toEqual({
        available: '100.000000000000000000',
        locked: '0.000000000000000000',
      });
      expect(await transferCountFor(sender.userId)).toBe(0);
    });

    it('refuses a self-transfer with 400 VALIDATION_FAILED before opening a transaction', async () => {
      const sender = await createUserWithWallet('self-transfer');
      await fund(sender.userId, '100');

      await transfer(sender.token, { recipientEmail: sender.email, amount: '10' }).expect(400);

      expect(await balancesOf(sender.userId)).toEqual({
        available: '100.000000000000000000',
        locked: '0.000000000000000000',
      });
      expect(await transferCountFor(sender.userId)).toBe(0);
    });

    it('refuses a zero or negative amount with 400 before any balance moves', async () => {
      const sender = await createUserWithWallet('zero-amount');
      const recipient = await createUser('zero-amount-recipient');
      await fund(sender.userId, '100');

      await transfer(sender.token, { recipientEmail: recipient.email, amount: '0' }).expect(400);
      await transfer(sender.token, { recipientEmail: recipient.email, amount: '-5' }).expect(400);

      expect(await balancesOf(sender.userId).then((b) => b.available)).toBe('100.000000000000000000');
      expect(await balancesOf(recipient.userId)).toEqual({
        available: '0.000000000000000000',
        locked: '0.000000000000000000',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Successful transfers
  // -------------------------------------------------------------------------

  describe('POST /api/ember/transfers - moving EMBER', () => {
    it('debits the sender, credits the recipient, writes both ledger legs and one transfer row', async () => {
      const sender = await createUserWithWallet('move-sender');
      const recipient = await createUserWithWallet('move-recipient');
      await fund(sender.userId, '1000');

      const clientRequestId = randomUUID();
      const response = await transfer(sender.token, {
        recipientEmail: recipient.email,
        amount: '250.5',
        clientRequestId,
      }).expect(201);

      const body = response.body as TransferPayload;
      expect(body).toEqual({
        transferId: expect.any(String),
        amount: '250.500000000000000000',
        transferredAt: expect.any(String),
      });
      // No counterparty identifiers leak in the response.
      expect(body).not.toHaveProperty('senderUserId');
      expect(body).not.toHaveProperty('recipientUserId');
      expect(body).not.toHaveProperty('walletId');

      expect(await balancesOf(sender.userId).then((b) => b.available)).toBe('749.500000000000000000');
      expect(await balancesOf(recipient.userId).then((b) => b.available)).toBe('250.500000000000000000');

      const row = await prisma.emberTransfer.findUniqueOrThrow({ where: { transferId: body.transferId } });
      expect(row.senderUserId).toBe(sender.userId);
      expect(row.recipientUserId).toBe(recipient.userId);
      expect(row.clientRequestId).toBe(clientRequestId);
      expect(row.amount.toFixed(18)).toBe('250.500000000000000000');

      const legs = await prisma.transaction.findMany({
        where: { walletId: { in: [
          (await prisma.wallet.findUniqueOrThrow({ where: { userId: sender.userId } })).id,
          (await prisma.wallet.findUniqueOrThrow({ where: { userId: recipient.userId } })).id,
        ] } },
        orderBy: { createdAt: 'asc' },
      });
      const transferLegs = legs.filter((leg) => leg.note === `EMBER transfer ${body.transferId}`);
      expect(transferLegs).toHaveLength(2);
      expect(transferLegs.map((leg) => leg.type).sort()).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
      expect(transferLegs.every((leg) => leg.amount.toFixed(18) === '250.500000000000000000')).toBe(true);
    });

    it('provisions the recipient wallet lazily when they never created one', async () => {
      const sender = await createUserWithWallet('lazy-sender');
      const recipient = await createUser('lazy-recipient-no-wallet');
      await fund(sender.userId, '100');

      expect(await prisma.wallet.count({ where: { userId: recipient.userId } })).toBe(0);

      await transfer(sender.token, { recipientEmail: recipient.email, amount: '40' }).expect(201);

      expect(await prisma.wallet.count({ where: { userId: recipient.userId } })).toBe(1);
      expect(await balancesOf(recipient.userId).then((b) => b.available)).toBe('40.000000000000000000');
    });

    it('resolves a mixed-case recipient email, matching how auth stores it', async () => {
      const sender = await createUserWithWallet('case-sender');
      const recipient = await createUser('case-recipient');
      await fund(sender.userId, '100');

      const response = await transfer(sender.token, {
        recipientEmail: recipient.email.toUpperCase(),
        amount: '10',
      }).expect(201);

      expect((response.body as TransferPayload).amount).toBe('10.000000000000000000');
      expect(await balancesOf(recipient.userId).then((b) => b.available)).toBe('10.000000000000000000');
    });

    it('refuses a transfer that exceeds the AVAILABLE balance with 409 INSUFFICIENT_BALANCE', async () => {
      const sender = await createUserWithWallet('insufficient-sender');
      const recipient = await createUser('insufficient-recipient');
      await fund(sender.userId, '100');

      const refused = await transfer(sender.token, {
        recipientEmail: recipient.email,
        amount: '100.01',
      }).expect(409);
      expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');

      expect(await balancesOf(sender.userId).then((b) => b.available)).toBe('100.000000000000000000');
      expect(await transferCountFor(sender.userId)).toBe(0);
    });

    it('cannot spend locked EMBER: a transfer funded only by the locked column is refused', async () => {
      const sender = await createUserWithWallet('locked-sender');
      const recipient = await createUser('locked-recipient');
      // 100 total, 80 of it locked - only 20 is spendable.
      await fund(sender.userId, '100');
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: sender.userId } });
      await walletService.lock(wallet.id, emberId(), '80');

      const refused = await transfer(sender.token, {
        recipientEmail: recipient.email,
        amount: '80',
      }).expect(409);
      expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');

      // The available remainder still transfers, and the lock is untouched.
      await transfer(sender.token, { recipientEmail: recipient.email, amount: '20' }).expect(201);
      expect(await balancesOf(sender.userId)).toEqual({
        available: '0.000000000000000000',
        locked: '80.000000000000000000',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('idempotency on (sender, clientRequestId)', () => {
    it('returns the original transfer on an identical replay without moving a balance twice', async () => {
      const sender = await createUserWithWallet('replay-sender');
      const recipient = await createUser('replay-recipient');
      await fund(sender.userId, '500');

      const clientRequestId = randomUUID();
      const payload = { recipientEmail: recipient.email, amount: '120', clientRequestId };

      const first = await transfer(sender.token, payload).expect(201);
      const second = await transfer(sender.token, payload).expect(200);

      expect(second.body).toEqual(first.body);
      expect(await balancesOf(sender.userId).then((b) => b.available)).toBe('380.000000000000000000');
      expect(await balancesOf(recipient.userId).then((b) => b.available)).toBe('120.000000000000000000');
      expect(await transferCountFor(sender.userId)).toBe(1);
    });

    it('refuses a replayed key whose amount differs with 409 CONFLICT', async () => {
      const sender = await createUserWithWallet('conflict-amount-sender');
      const recipient = await createUser('conflict-amount-recipient');
      await fund(sender.userId, '500');

      const clientRequestId = randomUUID();
      await transfer(sender.token, { recipientEmail: recipient.email, amount: '50', clientRequestId }).expect(201);

      const refused = await transfer(sender.token, {
        recipientEmail: recipient.email,
        amount: '51',
        clientRequestId,
      }).expect(409);
      expect(refused.body.code).toBe('CONFLICT');

      expect(await balancesOf(sender.userId).then((b) => b.available)).toBe('450.000000000000000000');
      expect(await transferCountFor(sender.userId)).toBe(1);
    });

    it('refuses a replayed key that now names a different recipient with 409 CONFLICT', async () => {
      const sender = await createUserWithWallet('conflict-recipient-sender');
      const first = await createUser('conflict-recipient-a');
      const second = await createUser('conflict-recipient-b');
      await fund(sender.userId, '500');

      const clientRequestId = randomUUID();
      await transfer(sender.token, { recipientEmail: first.email, amount: '50', clientRequestId }).expect(201);

      const refused = await transfer(sender.token, {
        recipientEmail: second.email,
        amount: '50',
        clientRequestId,
      }).expect(409);
      expect(refused.body.code).toBe('CONFLICT');

      // The second recipient never received anything.
      expect(await balancesOf(second.userId).then((b) => b.available)).toBe('0.000000000000000000');
      expect(await transferCountFor(sender.userId)).toBe(1);
    });

    it('scopes idempotency per sender: two users may reuse the same clientRequestId', async () => {
      const alice = await createUserWithWallet('scope-alice');
      const bob = await createUserWithWallet('scope-bob');
      const recipient = await createUser('scope-recipient');
      await fund(alice.userId, '100');
      await fund(bob.userId, '100');

      const clientRequestId = randomUUID();
      await transfer(alice.token, { recipientEmail: recipient.email, amount: '10', clientRequestId }).expect(201);
      await transfer(bob.token, { recipientEmail: recipient.email, amount: '10', clientRequestId }).expect(201);

      expect(await balancesOf(recipient.userId).then((b) => b.available)).toBe('20.000000000000000000');
      expect(await transferCountFor(alice.userId)).toBe(1);
      expect(await transferCountFor(bob.userId)).toBe(1);
    });

    it('settles two racing identical requests on exactly one transfer', async () => {
      const sender = await createUserWithWallet('race-same-sender');
      const recipient = await createUser('race-same-recipient');
      // Enough for both legs to pass the balance check, so the race resolves
      // on the unique insert - the path this test exists to exercise.
      await fund(sender.userId, '1000');

      const clientRequestId = randomUUID();
      const payload = { recipientEmail: recipient.email, amount: '100', clientRequestId };

      const [a, b] = await Promise.all([
        transfer(sender.token, payload),
        transfer(sender.token, payload),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as TransferPayload).transferId).toBe((b.body as TransferPayload).transferId);

      // Balances applied exactly once: 1000 - 100, and the recipient got 100.
      expect(await balancesOf(sender.userId).then((x) => x.available)).toBe('900.000000000000000000');
      expect(await balancesOf(recipient.userId).then((x) => x.available)).toBe('100.000000000000000000');
      expect(await transferCountFor(sender.userId)).toBe(1);
    });

    it('prevents a double spend across two different keys: exactly one wins, the balance never goes negative', async () => {
      const sender = await createUserWithWallet('race-double-spend');
      const recipient = await createUser('race-double-spend-recipient');
      await fund(sender.userId, '100');

      const [a, b] = await Promise.all([
        transfer(sender.token, { recipientEmail: recipient.email, amount: '80' }),
        transfer(sender.token, { recipientEmail: recipient.email, amount: '80' }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('INSUFFICIENT_BALANCE');

      expect(await balancesOf(sender.userId).then((x) => x.available)).toBe('20.000000000000000000');
      expect(await balancesOf(recipient.userId).then((x) => x.available)).toBe('80.000000000000000000');
      expect(await transferCountFor(sender.userId)).toBe(1);
    });

    it('rolls both legs back when the recipient wallet is frozen mid-path: sender unchanged, no transfer row', async () => {
      const sender = await createUserWithWallet('rollback-sender');
      const recipient = await createUserWithWallet('rollback-recipient');
      await fund(sender.userId, '200');

      const recipientWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: recipient.userId } });
      await prisma.wallet.update({ where: { id: recipientWallet.id }, data: { status: 'FROZEN' } });

      const refused = await transfer(sender.token, {
        recipientEmail: recipient.email,
        amount: '50',
      }).expect(409);
      expect(refused.body.code).toBe('WALLET_FROZEN');

      // The sender's debit, which ran first inside the transaction, is gone.
      expect(await balancesOf(sender.userId)).toEqual({
        available: '200.000000000000000000',
        locked: '0.000000000000000000',
      });
      expect(await balancesOf(recipient.userId).then((x) => x.available)).toBe('0.000000000000000000');
      expect(await transferCountFor(sender.userId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Supply metrics
  // -------------------------------------------------------------------------

  describe('GET /api/ember/supply - ledger-derived figures', () => {
    it('derives issued supply from deposits, reports zero burns, and counts transfers as movement only', async () => {
      const before = await supply();

      const sender = await createUserWithWallet('supply-sender');
      const recipient = await createUser('supply-recipient');
      await fund(sender.userId, '1000');

      const afterDeposit = await supply();
      expect(new Prisma.Decimal(afterDeposit.totalIssuedSupply).minus(before.totalIssuedSupply).toFixed(18)).toBe(
        '1000.000000000000000000',
      );
      expect(new Prisma.Decimal(afterDeposit.circulatingSupply).minus(before.circulatingSupply).toFixed(18)).toBe(
        '1000.000000000000000000',
      );

      await transfer(sender.token, { recipientEmail: recipient.email, amount: '300' }).expect(201);

      const afterTransfer = await supply();
      // A transfer moves value; it neither issues nor destroys.
      expect(afterTransfer.totalIssuedSupply).toBe(afterDeposit.totalIssuedSupply);
      expect(afterTransfer.circulatingSupply).toBe(afterDeposit.circulatingSupply);
      expect(afterTransfer.burnedSupply).toBe('0.000000000000000000');
      // Globally, available is unchanged by a transfer between two wallets.
      expect(afterTransfer.availableSupply).toBe(afterDeposit.availableSupply);
      expect(afterTransfer.lockedSupply).toBe(afterDeposit.lockedSupply);

      // Locking moves value between the two columns of one balance.
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: sender.userId } });
      await walletService.lock(wallet.id, emberId(), '200');

      const afterLock = await supply();
      expect(afterLock.totalIssuedSupply).toBe(afterDeposit.totalIssuedSupply);
      // The lock moved 200 EMBER from the available column to the locked
      // column of one balance: nothing issued, nothing destroyed.
      expect(new Prisma.Decimal(before.lockedSupply).plus('200').toFixed(18)).toBe(
        new Prisma.Decimal(afterLock.lockedSupply).toFixed(18),
      );
      expect(new Prisma.Decimal(before.availableSupply).plus('1000').minus('200').toFixed(18)).toBe(
        new Prisma.Decimal(afterLock.availableSupply).toFixed(18),
      );
      expect(afterLock.circulatingSupply).toBe(afterLock.totalIssuedSupply);
      expect(afterLock.burnedSupply).toBe('0.000000000000000000');
    });

    it('includes Module 09 LP commitment locks in lockedSupply and leaves the commitment untouched by transfers', async () => {
      const before = await supply();

      // A real LP through the real API: 150000 USDT commits against the
      // 100000 slab, which requires locking 20000 EMBER.
      const lp = await createUserWithWallet('supply-lp');
      const buyer = await createUserWithWallet('supply-buyer');
      await fund(lp.userId, '50000');
      const lpWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: lp.userId } });
      await walletService.credit(lpWallet.id, assetIdBySymbol.get('USDT') as string, '150000');
      await fund(buyer.userId, '5000');

      const commitmentResponse = await http()
        .post('/api/liquidity/commitments')
        .set(bearer(lp.token))
        .send({ usdtAmount: '150000', clientRequestId: randomUUID() })
        .expect(201);

      const commitment = (
        commitmentResponse.body as { commitment: { commitmentId: string; emberLocked: string; status: string } }
      ).commitment;
      expect(commitment.status).toBe('ACTIVE');
      expect(commitment.emberLocked).toBe('20000.000000000000000000');

      const afterCommitment = await supply();
      expect(
        new Prisma.Decimal(afterCommitment.lockedSupply).minus(before.lockedSupply).toFixed(18),
      ).toBe('20000.000000000000000000');

      // The LP has 30000 available (50000 - 20000). They cannot spend past it...
      const refused = await transfer(lp.token, {
        recipientEmail: buyer.email,
        amount: '30001',
      }).expect(409);
      expect(refused.body.code).toBe('INSUFFICIENT_BALANCE');

      // ...but the available remainder transfers and the lock is untouched.
      await transfer(lp.token, { recipientEmail: buyer.email, amount: '30000' }).expect(201);

      const afterTransfer = await supply();
      expect(afterTransfer.lockedSupply).toBe(afterCommitment.lockedSupply);
      expect(afterTransfer.totalIssuedSupply).toBe(afterCommitment.totalIssuedSupply);

      const me = await http().get('/api/liquidity/commitments/me').set(bearer(lp.token)).expect(200);
      const current = (me.body as { commitment: { status: string; emberLocked: string } }).commitment;
      expect(current.status).toBe('ACTIVE');
      expect(current.emberLocked).toBe('20000.000000000000000000');
    });

    it('reconciles the shared ledger: circulating = issued (burned is zero) and available + locked = circulating', async () => {
      const body = await supply();

      expect(body.asset).toBe('EMBER');
      // Module 10 implements no burn mechanism, so circulating equals issued.
      expect(body.burnedSupply).toBe('0.000000000000000000');
      expect(body.circulatingSupply).toBe(body.totalIssuedSupply);

      // Every EMBER the ledger issued must sit in some wallet's available or
      // locked column: transfers move value between wallets and locks move it
      // between columns, neither creates nor destroys. If these three figures
      // ever disagree, accounting has leaked.
      expect(
        new Prisma.Decimal(body.availableSupply).plus(body.lockedSupply).toFixed(18),
      ).toBe(new Prisma.Decimal(body.circulatingSupply).toFixed(18));
    });
  });
});
