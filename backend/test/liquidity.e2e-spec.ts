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
 * MODULE 09 - simulated liquidity over HTTP, against the real database and
 * the deterministic fake market (asks 100.10 x 5000 then 100.20 x 5000; bids
 * 99.90 x 5000 then 99.80 x 5000). Every BUY here walks a book VWAP of 100.10
 * and settles at 98.66 - the best-price guarantee's clear ₹1.50 inside
 * BetaExchange's executable ask of 100.1650225 - while a SELL settles at
 * 101.74, a ₹1.50 above AlphaExchange's bid.
 *
 * TEST-FIXTURE SLABS ONLY (see `liquidity-test-fixture.ts`): a zero-floor
 * slab of 1,000 EMBER, then 100k/250k/500k cliffs, threshold 5,000. These
 * equal the approved production table (2026-10-18); the fixture is still a
 * test-only env override applied before boot.
 *
 * The suite owns Module 09's global state: it resets the liquidity tables in
 * `beforeAll` and purges its rows in `afterAll`, and the e2e config runs files
 * serially so no other suite's provider rows are visible mid-run. That is what
 * lets the legacy phase (zero providers) and the insufficient-liquidity phase
 * (aggregate zero) be exact rather than hopeful.
 *
 * Money is read back from the real ledger throughout: LP USDT leaves only the
 * LP's own wallet, the customer's legs stay exactly Module 08's, and EMBER
 * locks move through WalletService inside the commitment's transaction.
 *
 * PHASE ORDER MATTERS: LPs accumulate state (consumption, increases, locks)
 * as the file runs, exactly like a real pool would. The declared sequence is
 * legacy -> register -> fund -> race -> starve -> notice -> reduce -> sell ->
 * admin distribution read (which only ever observes what the earlier phases
 * wrote).
 */
describe('Liquidity providers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const createdUserIds: string[] = [];
  const assetIdBySymbol = new Map<string, string>();

  interface CommitmentView {
    commitmentId: string;
    lpId: string;
    status: string;
    usdtCommitted: string;
    usdtConsumed: string;
    usdtAvailable: string;
    emberLocked: string;
    clientRequestId: string;
    closedAt: string | null;
  }

  interface Lp {
    token: string;
    userId: string;
    commitment: CommitmentView;
  }

  const lpRegistry = new Map<string, Lp>();
  const userIdByToken = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const lp = (label: string): Lp => {
    const entry = lpRegistry.get(label);
    if (!entry) throw new Error(`LP '${label}' was not registered yet`);
    return entry;
  };

  beforeAll(async () => {
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
      await prisma.usdtOrder.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    clearTestLiquidityEnv();
    await app.close();
  });

  async function createUser(label: string): Promise<{ token: string; userId: string }> {
    const token = await mintToken({
      subject: `google:${label}-${randomUUID()}`,
      email: `${label}-${randomUUID()}@liquidity.test`,
    });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);
    userIdByToken.set(token, response.body.id);

    return { token, userId: response.body.id };
  }

  async function createUserWithWallet(label: string): Promise<{ token: string; userId: string }> {
    const user = await createUser(label);
    await http().post('/api/wallets').set(bearer(user.token)).expect(201);
    return user;
  }

  async function fund(
    userId: string,
    funding: { inr?: string; usdt?: string; ember?: string },
  ): Promise<void> {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });

    if (funding.inr) {
      await walletService.credit(wallet.id, assetIdBySymbol.get('INR') as string, funding.inr);
    }
    if (funding.usdt) {
      await walletService.credit(wallet.id, assetIdBySymbol.get('USDT') as string, funding.usdt);
    }
    if (funding.ember) {
      await walletService.credit(wallet.id, assetIdBySymbol.get('EMBER') as string, funding.ember);
    }
  }

  /** Available/locked by symbol, formatted at the asset's display precision. */
  async function walletState(
    userId: string,
  ): Promise<Record<string, { available: string; locked: string }>> {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
      include: { balances: { include: { asset: true } } },
    });

    return Object.fromEntries(
      wallet.balances.map((balance) => [
        balance.asset.symbol,
        {
          available: balance.available.toFixed(balance.asset.decimals),
          locked: balance.locked.toFixed(balance.asset.decimals),
        },
      ]),
    );
  }

  interface BuyBody {
    orderId: string;
    inrAmount: string;
    liquidity?: {
      slices: Array<{
        commitmentId: string;
        lpId: string;
        usdtAmount: string;
        inrAmount: string;
        priceInr: string;
      }>;
      totalUsdt: string;
      totalInr: string;
    };
  }

  const buy = (token: string, usdtAmount: string, clientRequestId = randomUUID()) =>
    http().post('/api/usdt/buy').set(bearer(token)).send({ usdtAmount, clientRequestId });

  const sell = (token: string, usdtAmount: string, clientRequestId = randomUUID()) =>
    http().post('/api/usdt/sell').set(bearer(token)).send({ usdtAmount, clientRequestId });

  /** Registers a new LP through the real API and remembers them by label. */
  async function registerLp(
    label: string,
    commitment: { usdt: string; fundUsdt: string; fundEmber: string },
  ): Promise<Lp> {
    const user = await createUserWithWallet(label);
    await fund(user.userId, { usdt: commitment.fundUsdt, ember: commitment.fundEmber });

    const response = await http()
      .post('/api/liquidity/commitments')
      .set(bearer(user.token))
      .send({ usdtAmount: commitment.usdt, clientRequestId: randomUUID() })
      .expect(201);

    const entry: Lp = { token: user.token, userId: user.userId, commitment: response.body.commitment };
    lpRegistry.set(label, entry);
    return entry;
  }

  async function currentCommitment(token: string): Promise<CommitmentView> {
    const me = await http().get('/api/liquidity/commitments/me').set(bearer(token)).expect(200);
    return me.body.commitment as CommitmentView;
  }

  // -------------------------------------------------------------------------
  // Phase 0 - legacy behaviour with zero providers
  // -------------------------------------------------------------------------

  describe('legacy behaviour with no providers', () => {
    it('settles a BUY with no liquidity block and no allocation rows - Module 08 unchanged', async () => {
      const customer = await createUserWithWallet('legacy-customer');
      await fund(customer.userId, { inr: '10000' });

      const response = await buy(customer.token, '10').expect(201);

      expect(response.body).not.toHaveProperty('liquidity');
      // 10 USDT at the guaranteed 98.66 rather than the raw 100.10 book VWAP.
      expect(response.body.inrAmount).toBe('986.60');

      const allocations = await http()
        .get(`/api/liquidity/allocations/${response.body.orderId}`)
        .set(bearer(customer.token))
        .expect(200);
      expect(allocations.body.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 1 - registration and idempotent first commitment
  // -------------------------------------------------------------------------

  describe('commitment registration (EMBER-gated)', () => {
    it('auto-registers the LP, locks the slab requirement, and replays the first request exactly once', async () => {
      const lp1 = await registerLp('lp1', { usdt: '6000', fundUsdt: '6000', fundEmber: '5000' });

      // Zero-floor slab requires 1,000 EMBER, locked from available.
      expect(lp1.commitment).toMatchObject({
        status: 'ACTIVE',
        usdtCommitted: '6000.000000',
        usdtConsumed: '0.000000',
        usdtAvailable: '6000.000000',
        emberLocked: '1000.000000000000000000',
        closedAt: null,
      });

      const lp1Wallet = await walletState(lp1.userId);
      expect(lp1Wallet['USDT']).toEqual({ available: '6000.000000', locked: '0.000000' });
      expect(lp1Wallet['EMBER']).toEqual({
        available: '4000.000000000000000000',
        locked: '1000.000000000000000000',
      });

      // The lock is citable in the LP's own ledger.
      const ledger = await http().get('/api/wallets/me/transactions').set(bearer(lp1.token)).expect(200);
      const lockRows = (ledger.body.items as Array<{ type: string; note: string | null; asset: { symbol: string } }>).filter(
        (row) => row.note === `EMBER locked for liquidity commitment ${lp1.commitment.commitmentId}`,
      );
      expect(lockRows).toHaveLength(1);
      expect(lockRows[0]).toMatchObject({ type: 'LOCK', asset: { symbol: 'EMBER' } });

      // Replaying the identical request applies nothing a second time.
      const replay = await http()
        .post('/api/liquidity/commitments')
        .set(bearer(lp1.token))
        .send({ usdtAmount: '6000', clientRequestId: lp1.commitment.clientRequestId })
        .expect(200);

      expect(replay.body).toMatchObject({ created: false, replayed: true });
      expect((replay.body.commitment as CommitmentView).usdtCommitted).toBe('6000.000000');

      const afterReplay = await walletState(lp1.userId);
      expect(afterReplay['EMBER']).toEqual({
        available: '4000.000000000000000000',
        locked: '1000.000000000000000000',
      });
    });

    it('gives each further LP its own row and reports commitments/me per caller', async () => {
      const lp2 = await registerLp('lp2', { usdt: '3000', fundUsdt: '3000', fundEmber: '2000' });
      expect(lp2.commitment).toMatchObject({
        usdtCommitted: '3000.000000',
        emberLocked: '1000.000000000000000000',
      });

      const me = await http().get('/api/liquidity/commitments/me').set(bearer(lp2.token)).expect(200);
      expect(me.body).toMatchObject({
        commitmentsEnabled: true,
        provider: { lpId: lp2.commitment.lpId, status: 'ACTIVE' },
        commitment: { commitmentId: lp2.commitment.commitmentId },
      });

      const stranger = await createUser('stranger');
      const strangerMe = await http().get('/api/liquidity/commitments/me').set(bearer(stranger.token)).expect(200);
      expect(strangerMe.body).toEqual({ provider: null, commitment: null, commitmentsEnabled: true });
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2-4 - allocation, spanning, the race, and the starvation refusal
  // -------------------------------------------------------------------------

  describe('allocation of customer BUY orders', () => {
    let lp3: Lp;

    beforeAll(async () => {
      lp3 = await registerLp('lp3', { usdt: '1000', fundUsdt: '1000', fundEmber: '2000' });
    });

    it('draws 5,000 USDT entirely from the oldest commitment, writing both LP legs', async () => {
      const customer = await createUserWithWallet('funded-customer');
      await fund(customer.userId, { inr: '5000000' });

      const response = await buy(customer.token, '5000').expect(201);
      const body = response.body as BuyBody;

      expect(body.liquidity).toEqual({
        slices: [
          {
            commitmentId: lp('lp1').commitment.commitmentId,
            lpId: lp('lp1').commitment.lpId,
            usdtAmount: '5000.000000',
            inrAmount: '493300.00',
            priceInr: '98.66',
          },
        ],
        totalUsdt: '5000.000000',
        totalInr: '493300.00',
      });

      // The customer's legs are exactly Module 08's - LPs fund, they do not charge.
      const customerState = await walletState(customer.userId);
      expect(customerState['INR']).toEqual({ available: '4506700.00', locked: '0.00' });
      expect(customerState['USDT']).toEqual({ available: '5000.000000', locked: '0.000000' });

      // LP1 paid the slice out of their own wallet at the order's price.
      const lp1State = await walletState(lp('lp1').userId);
      expect(lp1State['USDT']).toEqual({ available: '1000.000000', locked: '0.000000' });
      expect(lp1State['INR']).toEqual({ available: '493300.00', locked: '0.00' });

      // Consumption never touches the EMBER lock.
      expect(await currentCommitment(lp('lp1').token)).toMatchObject({
        usdtCommitted: '6000.000000',
        usdtConsumed: '5000.000000',
        usdtAvailable: '1000.000000',
        emberLocked: '1000.000000000000000000',
      });

      // The slices are readable for the caller's own order...
      const allocations = await http()
        .get(`/api/liquidity/allocations/${body.orderId}`)
        .set(bearer(customer.token))
        .expect(200);
      expect(allocations.body.items).toHaveLength(1);
      expect(allocations.body.items[0]).toMatchObject({
        commitmentId: lp('lp1').commitment.commitmentId,
        usdtAmount: '5000.000000',
        priceInr: '98.66',
      });

      // ...and for nobody else.
      const other = await createUser('not-the-owner');
      await http()
        .get(`/api/liquidity/allocations/${body.orderId}`)
        .set(bearer(other.token))
        .expect(404);
    });

    it('spans two commitments oldest-first when one cannot cover the order', async () => {
      const customer = await createUserWithWallet('span-customer');
      await fund(customer.userId, { inr: '1000000' });

      const response = await buy(customer.token, '4000').expect(201);
      const body = response.body as BuyBody;

      // Oldest first: LP1's remaining 1,000, then LP2's 3,000. The final slice
      // carries the customer-debit remainder so the ledger adds up exactly.
      expect(body.liquidity?.slices).toEqual([
        {
          commitmentId: lp('lp1').commitment.commitmentId,
          lpId: lp('lp1').commitment.lpId,
          usdtAmount: '1000.000000',
          inrAmount: '98660.00',
          priceInr: '98.66',
        },
        {
          commitmentId: lp('lp2').commitment.commitmentId,
          lpId: lp('lp2').commitment.lpId,
          usdtAmount: '3000.000000',
          inrAmount: '295980.00',
          priceInr: '98.66',
        },
      ]);
      expect(body.liquidity?.totalUsdt).toBe('4000.000000');
      expect(body.liquidity?.totalInr).toBe('394640.00');
      expect(body.inrAmount).toBe('394640.00');

      const lp1State = await walletState(lp('lp1').userId);
      expect(lp1State['USDT']).toEqual({ available: '0.000000', locked: '0.000000' });
      expect(lp1State['INR']).toEqual({ available: '591960.00', locked: '0.00' });

      const lp2State = await walletState(lp('lp2').userId);
      expect(lp2State['USDT']).toEqual({ available: '0.000000', locked: '0.000000' });
      expect(lp2State['INR']).toEqual({ available: '295980.00', locked: '0.00' });
    });

    it('settles exactly one of two racing BUYs that share the last liquidity, refusing the other', async () => {
      const customer = await createUserWithWallet('race-customer');
      // INR for BOTH orders, so the loser's 409 can only come from liquidity
      // exhaustion - never from the customer's own balance guard.
      await fund(customer.userId, { inr: '300000' });

      const [first, second] = await Promise.all([buy(customer.token, '1000'), buy(customer.token, '1000')]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const refused = first.status === 409 ? first : second;
      expect(refused.body.code).toBe('INSUFFICIENT_LIQUIDITY');

      // Exactly one order exists and the customer paid for exactly one.
      const orders = await http().get('/api/usdt/orders').set(bearer(customer.token)).expect(200);
      expect(orders.body.items).toHaveLength(1);

      const customerState = await walletState(customer.userId);
      expect(customerState['USDT']).toEqual({ available: '1000.000000', locked: '0.000000' });
      expect(customerState['INR']).toEqual({ available: '201340.00', locked: '0.00' });

      // LP3 - the only commitment with liquidity left - funded exactly one slice.
      expect(await walletState(lp3.userId)).toEqual({
        EMBER: { available: '1000.000000000000000000', locked: '1000.000000000000000000' },
        INR: { available: '98660.00', locked: '0.00' },
        USDT: { available: '0.000000', locked: '0.000000' },
      });
    });

    it('refuses the next BUY with 409 INSUFFICIENT_LIQUIDITY and moves nothing at all', async () => {
      const customer = await createUserWithWallet('starved-customer');
      // Enough INR to cover the quote (1,000 x 98.66 = 98,660.00) so the
      // refusal can only come from liquidity.
      await fund(customer.userId, { inr: '200000' });

      const before = await walletState(customer.userId);
      const lp3Before = await walletState(lp3.userId);

      const response = await buy(customer.token, '1000').expect(409);

      expect(response.body).toMatchObject({
        code: 'INSUFFICIENT_LIQUIDITY',
        details: ['requested_usdt:1000.000000', 'available_usdt:0.000000'],
      });

      expect(await walletState(customer.userId)).toEqual(before);
      expect(await walletState(lp3.userId)).toEqual(lp3Before);

      const orders = await http().get('/api/usdt/orders').set(bearer(customer.token)).expect(200);
      expect(orders.body.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 5 - shortfall detection
  // -------------------------------------------------------------------------

  describe('overview and top-up notices', () => {
    it('opens at most one notice below the threshold and fulfils it once liquidity recovers', async () => {
      const first = await http().get('/api/liquidity/overview').set(bearer(lp('lp1').token)).expect(200);
      expect(first.body).toMatchObject({
        aggregateAvailableUsdt: '0.000000',
        thresholdUsdt: '5000.000000',
        shortfallUsdt: '5000.000000',
        belowThreshold: true,
        commitmentsEnabled: true,
      });
      const openId = (first.body.openRequest as { topUpRequestId: string }).topUpRequestId;

      // A second read reuses the same notice rather than opening another.
      const second = await http().get('/api/liquidity/overview').set(bearer(lp('lp1').token)).expect(200);
      expect((second.body.openRequest as { topUpRequestId: string }).topUpRequestId).toBe(openId);

      const list = await http().get('/api/liquidity/topups').set(bearer(lp('lp1').token)).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({
        topUpRequestId: openId,
        status: 'OPEN',
        requiredUsdt: '5000.000000',
        thresholdUsdt: '5000.000000',
      });

      // An LP increasing past the threshold resolves the notice - detection
      // moves no funds itself; the commitment increase is the response.
      await fund(lp('lp1').userId, { usdt: '94000', ember: '20000' });

      const increase = await http()
        .post('/api/liquidity/commitments')
        .set(bearer(lp('lp1').token))
        .send({ usdtAmount: '94000', clientRequestId: randomUUID() })
        .expect(200);
      expect(increase.body).toMatchObject({ created: false, replayed: false });

      expect(increase.body.commitment as CommitmentView).toMatchObject({
        usdtCommitted: '100000.000000',
        usdtConsumed: '6000.000000',
        usdtAvailable: '94000.000000',
        // Slab 1 (>= 100,000) requires 20,000: only the 19,000 delta was locked.
        emberLocked: '20000.000000000000000000',
      });

      const lp1Ember = await walletState(lp('lp1').userId);
      expect(lp1Ember['EMBER']).toEqual({
        available: '5000.000000000000000000',
        locked: '20000.000000000000000000',
      });

      const recovered = await http().get('/api/liquidity/overview').set(bearer(lp('lp1').token)).expect(200);
      expect(recovered.body).toMatchObject({
        aggregateAvailableUsdt: '94000.000000',
        belowThreshold: false,
        openRequest: null,
      });

      const fulfilled = await http().get('/api/liquidity/topups').set(bearer(lp('lp1').token)).expect(200);
      expect(fulfilled.body.items[0]).toMatchObject({
        topUpRequestId: openId,
        status: 'FULFILLED',
      });
      expect(fulfilled.body.items[0].resolvedAt).toEqual(expect.any(String));
    });

    it('replays an increase that reuses its clientRequestId without applying twice', async () => {
      const before = await currentCommitment(lp('lp1').token);

      const replay = await http()
        .post('/api/liquidity/commitments')
        .set(bearer(lp('lp1').token))
        .send({ usdtAmount: '94000', clientRequestId: before.clientRequestId })
        .expect(200);

      expect(replay.body).toMatchObject({ created: false, replayed: true });
      expect(await currentCommitment(lp('lp1').token)).toMatchObject({
        usdtCommitted: '100000.000000',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Phase 6 - reductions
  // -------------------------------------------------------------------------

  describe('commitment reductions', () => {
    it('closes a fully unconsumed commitment, unlocking the EMBER entirely, idempotently', async () => {
      const lp4 = await registerLp('lp4', { usdt: '2000', fundUsdt: '2000', fundEmber: '2000' });

      const reduce = await http()
        .post('/api/liquidity/commitments/reduce')
        .set(bearer(lp4.token))
        .send({
          commitmentId: lp4.commitment.commitmentId,
          usdtAmount: '2000',
          clientRequestId: randomUUID(),
        })
        .expect(201);

      expect(reduce.body.reduction).toMatchObject({
        usdtAmount: '2000.000000',
        emberUnlocked: '1000.000000000000000000',
      });
      expect(reduce.body.replayed).toBe(false);

      const closed = await currentCommitment(lp4.token);
      expect(closed).toMatchObject({
        status: 'CLOSED',
        usdtCommitted: '0.000000',
        usdtAvailable: '0.000000',
        emberLocked: '0.000000000000000000',
      });
      expect(closed.closedAt).toEqual(expect.any(String));

      const lp4State = await walletState(lp4.userId);
      expect(lp4State['EMBER']).toEqual({
        available: '2000.000000000000000000',
        locked: '0.000000000000000000',
      });
      // The pledged USDT never left the LP wallet - closing only drops eligibility.
      expect(lp4State['USDT']).toEqual({ available: '2000.000000', locked: '0.000000' });

      // Replay returns the original reduction and unlocks nothing again.
      const replay = await http()
        .post('/api/liquidity/commitments/reduce')
        .set(bearer(lp4.token))
        .send({
          commitmentId: lp4.commitment.commitmentId,
          usdtAmount: '2000',
          clientRequestId: (reduce.body.reduction as { clientRequestId: string }).clientRequestId,
        })
        .expect(200);
      expect(replay.body.replayed).toBe(true);

      // LP4 never held INR, so their wallet has only the two seeded assets.
      expect(await walletState(lp4.userId)).toEqual({
        EMBER: { available: '2000.000000000000000000', locked: '0.000000000000000000' },
        USDT: { available: '2000.000000', locked: '0.000000' },
      });

      // A closed commitment accepts no further reduction.
      await http()
        .post('/api/liquidity/commitments/reduce')
        .set(bearer(lp4.token))
        .send({
          commitmentId: lp4.commitment.commitmentId,
          usdtAmount: '1',
          clientRequestId: randomUUID(),
        })
        .expect(409);
    });

    it("refuses to withdraw consumed liquidity, and another caller's commitment with 404", async () => {
      const commitmentId = (await currentCommitment(lp('lp1').token)).commitmentId;

      // 94,000 available, but the reduction may never go below available.
      const over = await http()
        .post('/api/liquidity/commitments/reduce')
        .set(bearer(lp('lp1').token))
        .send({ commitmentId, usdtAmount: '94001', clientRequestId: randomUUID() })
        .expect(409);
      expect(over.body.message).toContain('cannot be reduced below');

      const customer = await createUser('reduce-stranger');
      await http()
        .post('/api/liquidity/commitments/reduce')
        .set(bearer(customer.token))
        .send({ commitmentId, usdtAmount: '1', clientRequestId: randomUUID() })
        .expect(404);
    });

    it('unlocks only the surplus when a reduction crosses back below a slab', async () => {
      const commitmentId = (await currentCommitment(lp('lp1').token)).commitmentId;

      // 100,000 -> 50,000 falls back to the zero-floor slab (1,000 EMBER):
      // 19,000 of surplus unlocks, and the 6,000 consumed portion keeps its lock.
      const reduce = await http()
        .post('/api/liquidity/commitments/reduce')
        .set(bearer(lp('lp1').token))
        .send({ commitmentId, usdtAmount: '50000', clientRequestId: randomUUID() })
        .expect(201);

      expect(reduce.body.reduction).toMatchObject({
        usdtAmount: '50000.000000',
        emberUnlocked: '19000.000000000000000000',
      });

      expect(await currentCommitment(lp('lp1').token)).toMatchObject({
        status: 'ACTIVE',
        usdtCommitted: '50000.000000',
        usdtConsumed: '6000.000000',
        usdtAvailable: '44000.000000',
        emberLocked: '1000.000000000000000000',
      });

      const lp1Ember = await walletState(lp('lp1').userId);
      expect(lp1Ember['EMBER']).toEqual({
        available: '24000.000000000000000000',
        locked: '1000.000000000000000000',
      });

      // Withdrawing the remaining available liquidity floors at the consumed
      // portion: the commitment stays ACTIVE, still holding its lock.
      await http()
        .post('/api/liquidity/commitments/reduce')
        .set(bearer(lp('lp1').token))
        .send({ commitmentId, usdtAmount: '44000', clientRequestId: randomUUID() })
        .expect(201);

      expect(await currentCommitment(lp('lp1').token)).toMatchObject({
        status: 'ACTIVE',
        usdtCommitted: '6000.000000',
        usdtAvailable: '0.000000',
        emberLocked: '1000.000000000000000000',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Phase 7 - SELL is untouched
  // -------------------------------------------------------------------------

  describe('SELL never touches liquidity', () => {
    it('settles a SELL with no liquidity block and leaves every commitment untouched', async () => {
      const customer = await createUserWithWallet('sell-customer');
      await fund(customer.userId, { usdt: '100' });

      const before = await currentCommitment(lp('lp1').token);

      const response = await sell(customer.token, '100').expect(201);
      expect(response.body).not.toHaveProperty('liquidity');

      const after = await currentCommitment(lp('lp1').token);
      expect(after.usdtConsumed).toBe(before.usdtConsumed);
      expect(after.usdtAvailable).toBe(before.usdtAvailable);
    });
  });

  describe('admin distribution read (GET /liquidity/distribution)', () => {
    const dec = (value: string) => new Prisma.Decimal(value);

    it('refuses every non-admin caller with 403 - including the providers themselves', async () => {
      await http().get('/api/liquidity/distribution').set(bearer(lp('lp1').token)).expect(403);

      const stranger = await createUser('dist-stranger');
      await http().get('/api/liquidity/distribution').set(bearer(stranger.token)).expect(403);
    });

    it('shows an admin how USDT is distributed, reconciling every row to the ledgers', async () => {
      const admin = await createUser('dist-admin');
      await prisma.userRole.upsert({
        where: { userId_role: { userId: admin.userId, role: 'PLATFORM_ADMIN' } },
        create: { userId: admin.userId, role: 'PLATFORM_ADMIN' },
        update: {},
      });

      const response = await http()
        .get('/api/liquidity/distribution')
        .set(bearer(admin.token))
        .expect(200);

      const body = response.body as {
        totals: {
          totalCommittedUsdt: string;
          totalDistributedUsdt: string;
          totalRemainingUsdt: string;
          providerCount: number;
          allocationCount: number;
          belowThreshold: boolean;
          thresholdUsdt: string;
        };
        providers: Array<{
          email: string;
          contributedUsdt: string;
          shareOfCommittedPct: string;
          commitment: {
            usdtCommitted: string;
            usdtConsumed: string;
            usdtAvailable: string;
          } | null;
        }>;
        recentAllocations: Array<{ providerEmail: string; usdtAmount: string }>;
      };

      // Both registered providers appear exactly once, counts agreeing.
      expect(body.totals.providerCount).toBeGreaterThanOrEqual(2);
      expect(body.providers).toHaveLength(body.totals.providerCount);
      const emails = body.providers.map((row) => row.email);
      expect(new Set(emails).size).toBe(emails.length);

      // Pool invariant in exact decimals: remaining = committed - distributed.
      expect(
        dec(body.totals.totalCommittedUsdt).sub(dec(body.totals.totalDistributedUsdt)).toFixed(6),
      ).toBe(dec(body.totals.totalRemainingUsdt).toFixed(6));

      let shareSum = 0;
      for (const row of body.providers) {
        shareSum += Number(row.shareOfCommittedPct);
        if (row.commitment) {
          // The same invariant, row by row...
          expect(
            dec(row.commitment.usdtCommitted).sub(dec(row.commitment.usdtConsumed)).toFixed(6),
          ).toBe(dec(row.commitment.usdtAvailable).toFixed(6));
          // ...and every unit the ledger calls consumed is backed by real
          // allocation slices - contribution is evidence, not a separate count.
          expect(dec(row.contributedUsdt).toFixed(6)).toBe(
            dec(row.commitment.usdtConsumed).toFixed(6),
          );
        }
      }
      // Rounding to 2 dp per row, so ~100 rather than exactly 100.
      expect(shareSum).toBeGreaterThanOrEqual(99);
      expect(shareSum).toBeLessThanOrEqual(101);

      // Earlier phases placed BUYs, so slices exist and the recent list names
      // the provider that funded each one.
      expect(body.totals.allocationCount).toBeGreaterThan(0);
      expect(body.recentAllocations.length).toBeGreaterThan(0);
      const recent = body.recentAllocations[0];
      expect(recent?.providerEmail).toBeTruthy();
      expect(dec(recent?.usdtAmount ?? '0').gt(0)).toBe(true);
    });
  });
});
