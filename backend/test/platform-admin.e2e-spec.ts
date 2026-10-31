import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AssetKind } from '@prisma/client';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { seedAssets } from '../src/modules/assets/asset-seed';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { mintToken } from './token-minting';

/**
 * PLATFORM ADMIN - money and account controls over HTTP.
 *
 * Boots the real application so the global guard stack, the real ledger
 * (ADJUSTMENT legs with their snapshots) and the real audit trail are all
 * under test. Nothing is stubbed: what these endpoints promise is an exact
 * balance change plus an audit row that names the actor, the account, the
 * amount and the reason, and only a real database can prove all of that.
 *
 * The treasury footprint is purged at start AND end exactly as the treasury
 * suite does, so a funded EMBER inventory or an added user balance can never
 * leak into another suite's baselines (or into the dev data the suites run
 * against). Suites run serially (maxWorkers 1), so the purge is reliable.
 */
describe('Platform admin - funding, adjustments, freeze and suspend (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletService: WalletService;

  const TREASURY_EMAIL = 'treasury@prometheus.local';
  const createdUserIds: string[] = [];
  const createdAssetIds: string[] = [];

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const emailFor = (label: string) => `${label}-${randomUUID()}@platform-admin.test`;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    walletService = app.get(WalletService);

    await seedAssets(prisma);
    await purgeTreasuryFootprint();
  });

  afterAll(async () => {
    await purgeAuditRows(createdUserIds);
    await purgeTreasuryFootprint();
    await purgeSuiteUsers();
    await purgeSuiteAssets();
    await app.close();
  });

  /** The suite's own asset rows are removed after their audit trail. */
  async function purgeSuiteAssets(): Promise<void> {
    if (createdAssetIds.length === 0) return;
    await prisma.adminAuditLog.deleteMany({ where: { detail: { path: ['asset'], equals: 'SUITE-TEST' } } });
    await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
    createdAssetIds.length = 0;
  }

  /**
   * The treasury account, purged start AND end like the treasury suite owns
   * after its runs: deleting its movements, balances and wallet must come
   * before the user row. The funded EMBER cannot survive this.
   */
  async function purgeTreasuryFootprint(): Promise<void> {
    const treasury = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL } });
    if (!treasury) return;
    await prisma.transaction.deleteMany({ where: { wallet: { userId: treasury.id } } });
    await prisma.walletBalance.deleteMany({ where: { wallet: { userId: treasury.id } } });
    await prisma.wallet.deleteMany({ where: { userId: treasury.id } });
    await prisma.adminAuditLog.deleteMany({ where: { targetUserId: treasury.id } });
    await prisma.user.delete({ where: { id: treasury.id } });
  }

  /** Audit rows this suite produced are removed before their subjects so a later suite sees none of them. */
  async function purgeAuditRows(userIds: string[]): Promise<void> {
    await prisma.adminAuditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  }

  async function purgeSuiteUsers(): Promise<void> {
    if (createdUserIds.length === 0) return;
    await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
    await prisma.walletBalance.deleteMany({ where: { wallet: { userId: { in: createdUserIds } } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }

  /** First login (which provisions the account) and, optionally, the admin grant. */
  async function createIdentity(
    label: string,
    options: { admin?: boolean } = {},
  ): Promise<{ token: string; userId: string; email: string }> {
    const email = emailFor(label);
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });
    const me = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    const userId = me.body.id as string;
    createdUserIds.push(userId);

    if (options.admin) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId, role: 'PLATFORM_ADMIN' } },
        create: { userId, role: 'PLATFORM_ADMIN' },
        update: {},
      });
    }
    return { token, userId, email };
  }

  /** Provisions the treasury system account the way Module 09's pattern does. */
  async function ensureTreasury(): Promise<{ userId: string; walletId: string }> {
    let user = await prisma.user.findUnique({ where: { email: TREASURY_EMAIL } });
    if (!user) {
      user = await prisma.user.create({ data: { email: TREASURY_EMAIL } });
    }
    const { wallet } = await walletService.getOrCreateForUser(user.id);
    return { userId: user.id, walletId: wallet.id };
  }

  /** Reads the treasury's available balance for an asset, scaled to whole units for arithmetic. */
  async function treasuryBalance(assetSymbol: 'EMBER' | 'USDT' | 'INR'): Promise<string> {
    const treasury = await prisma.user.findUniqueOrThrow({ where: { email: TREASURY_EMAIL } });
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: treasury.id } });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol: assetSymbol } });
    const balance = await prisma.walletBalance.findUnique({
      where: { walletId_assetId: { walletId: wallet.id, assetId: asset.id } },
    });
    return balance ? balance.available.toFixed(asset.decimals) : '0';
  }

  /** Exact 18dp fixed-scale comparison helper: parses a fixed-point string into a BigInt. */
  function scaledToFemto(value: string): bigint {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(18, '0').slice(0, 18)}`);
  }

  const FUNDING_BODY = { assetSymbol: 'EMBER', amount: '100000', note: 'Hub inventory top-up for the e2e suite' };

  describe('when no usable token is present', () => {
    it('refuses funding', async () => {
      await http().post('/api/admin/platform/treasury/funding').send(FUNDING_BODY).expect(401);
    });

    it('refuses a wallet movement', async () => {
      await http()
        .post('/api/admin/platform/users/00000000-0000-0000-0000-000000000000/wallet-movements')
        .send({ kind: 'CREDIT', assetSymbol: 'INR', amount: '1.00', note: 'x' })
        .expect(401);
    });
  });

  describe('when the caller is not a platform admin', () => {
    it('refuses the whole admin/platform surface with 403', async () => {
      const user = await createIdentity('non-admin');
      await http()
        .post('/api/admin/platform/treasury/funding')
        .set(bearer(user.token))
        .send(FUNDING_BODY)
        .expect(403);
    });
  });

  describe('treasury funding', () => {
    it('credits the treasury wallet, writes an ADJUSTMENT leg and an audit row', async () => {
      const admin = await createIdentity('funding-admin', { admin: true });
      const { walletId } = await ensureTreasury();
      const before = await treasuryBalance('EMBER');

      const res = await http()
        .post('/api/admin/platform/treasury/funding')
        .set(bearer(admin.token))
        .send(FUNDING_BODY)
        .expect(200);

      expect(res.body).toMatchObject({
        walletId,
        ledgerType: 'ADJUSTMENT',
        asset: { symbol: 'EMBER' },
      });

      const after = await treasuryBalance('EMBER');
      expect(scaledToFemto(after) - scaledToFemto(before)).toBe(BigInt('100000') * BigInt(10) ** BigInt(18));

      const leg = await prisma.transaction.findFirst({
        where: { walletId, type: 'ADJUSTMENT', note: FUNDING_BODY.note },
        orderBy: { createdAt: 'desc' },
      });
      expect(leg).not.toBeNull();
      expect(leg?.amount).toBeInstanceOf(Object);

      const audit = await prisma.adminAuditLog.findFirst({
        where: { actorUserId: admin.userId, action: 'treasury.funding' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.detail).toMatchObject({ asset: 'EMBER', amount: '100000' });
    });

    it('refuses a zero amount, an over-precise INR amount and a blank note', async () => {
      const admin = await createIdentity('funding-validation', { admin: true });

      await http()
        .post('/api/admin/platform/treasury/funding')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'INR', amount: '0', note: 'capital' })
        .expect(400);

      await http()
        .post('/api/admin/platform/treasury/funding')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'INR', amount: '1.005', note: 'capital' })
        .expect(400);

      await http()
        .post('/api/admin/platform/treasury/funding')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'INR', amount: '500.00', note: '   ' })
        .expect(400);

      await http()
        .post('/api/admin/platform/treasury/funding')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'FOOBAR', amount: '500.00', note: 'capital' })
        .expect(404);
    });
  });

  describe('user wallet movements', () => {
    it('credits INR, then debits part of it, both audited as ADJUSTMENT', async () => {
      const admin = await createIdentity('movement-admin', { admin: true });
      const target = await createIdentity('movement-target');

      const credited = await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'CREDIT', assetSymbol: 'inr', amount: '2500.00', note: 'Grant of capital' })
        .expect(200);

      expect(credited.body).toMatchObject({ asset: { symbol: 'INR' }, available: '2500.00' });

      const debited = await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'DEBIT', assetSymbol: 'INR', amount: '500.00', note: 'Correction' })
        .expect(200);

      expect(debited.body.available).toBe('2000.00');

      const legs = await prisma.transaction.findMany({
        where: { wallet: { userId: target.userId }, type: 'ADJUSTMENT' },
        orderBy: { createdAt: 'asc' },
      });
      expect(legs).toHaveLength(2);
      expect(legs.map((leg) => noteOf(leg.note))).toEqual(['Grant of capital', 'Correction']);

      const audits = await prisma.adminAuditLog.findMany({
        where: { actorUserId: admin.userId, targetUserId: target.userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((row) => row.action)).toEqual(['wallet.credit', 'wallet.debit']);
    });

    it('refuses a debit the balance cannot fund and an unknown user', async () => {
      const admin = await createIdentity('movement-refusal', { admin: true });
      const target = await createIdentity('movement-refusal-target');

      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'DEBIT', assetSymbol: 'INR', amount: '1.00', note: 'over the balance' })
        .expect(409);

      await http()
        .post('/api/admin/platform/users/00000000-0000-0000-0000-00000000000f/wallet-movements')
        .set(bearer(admin.token))
        .send({ kind: 'CREDIT', assetSymbol: 'INR', amount: '1.00', note: 'ghost' })
        .expect(404);
    });
  });

  describe('wallet freeze and unfreeze', () => {
    it('freezes so that no movement passes, then unfreezes', async () => {
      const admin = await createIdentity('freeze-admin', { admin: true });
      const target = await createIdentity('freeze-target');

      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'CREDIT', assetSymbol: 'USDT', amount: '10', note: 'seed for freeze test' })
        .expect(200);

      const frozen = await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-status`)
        .set(bearer(admin.token))
        .send({ status: 'FROZEN' })
        .expect(200);
      expect(frozen.body).toMatchObject({ walletStatus: 'FROZEN' });

      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'CREDIT', assetSymbol: 'USDT', amount: '1', note: 'must not move' })
        .expect(409);

      const audit = await prisma.adminAuditLog.findFirst({
        where: { actorUserId: admin.userId, targetUserId: target.userId, action: 'wallet.status' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.detail).toMatchObject({ to: 'FROZEN' });

      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-status`)
        .set(bearer(admin.token))
        .send({ status: 'FROZEN' })
        .expect(409);

      const unfrozen = await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-status`)
        .set(bearer(admin.token))
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(unfrozen.body).toMatchObject({ walletStatus: 'ACTIVE' });
    });

    it('refuses to freeze when the wallet does not exist', async () => {
      const admin = await createIdentity('freeze-none', { admin: true });
      const target = await createIdentity('freeze-none-target');

      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-status`)
        .set(bearer(admin.token))
        .send({ status: 'FROZEN' })
        .expect(404);
    });
  });

  describe('user lifecycle status', () => {
    it('suspends (existing token stops resolving), then reactivates', async () => {
      const admin = await createIdentity('suspend-admin', { admin: true });
      const target = await createIdentity('suspend-target');

      const suspended = await http()
        .post(`/api/admin/platform/users/${target.userId}/status`)
        .set(bearer(admin.token))
        .send({ status: 'SUSPENDED' })
        .expect(200);
      expect(suspended.body).toMatchObject({ userId: target.userId, status: 'SUSPENDED' });

      // resolveIdentity refuses non-ACTIVE on every request, so the token is dead immediately.
      await http().get('/api/auth/me').set(bearer(target.token)).expect(403);

      await http()
        .post(`/api/admin/platform/users/${target.userId}/status`)
        .set(bearer(admin.token))
        .send({ status: 'SUSPENDED' })
        .expect(409);

      await http()
        .post(`/api/admin/platform/users/${target.userId}/status`)
        .set(bearer(admin.token))
        .send({ status: 'ACTIVE' })
        .expect(200);
      await http().get('/api/auth/me').set(bearer(target.token)).expect(200);
    });

    it('refuses unknown users', async () => {
      const admin = await createIdentity('suspend-none', { admin: true });
      await http()
        .post(`/api/admin/platform/users/00000000-0000-0000-0000-00000000000a/status`)
        .set(bearer(admin.token))
        .send({ status: 'SUSPENDED' })
        .expect(404);
    });
  });

  describe('treasury withdrawal', () => {
    it('debits the treasury, writes the audit row, and is refused past the balance', async () => {
      const admin = await createIdentity('withdrawal-admin', { admin: true });
      await ensureTreasury();

      await http()
        .post('/api/admin/platform/treasury/funding')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'USDT', amount: '1000', note: 'seed for withdrawal' })
        .expect(200);
      const before = await treasuryBalance('USDT');

      const res = await http()
        .post('/api/admin/platform/treasury/withdrawal')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'usdt', amount: '400.000000', note: 'Capital removal' })
        .expect(200);
      expect(res.body).toMatchObject({ ledgerType: 'ADJUSTMENT', asset: { symbol: 'USDT' } });

      const after = await treasuryBalance('USDT');
      expect(scaledToFemto(before) - scaledToFemto(after)).toBe(BigInt('400') * BigInt(10) ** BigInt(18));

      const audits = await prisma.adminAuditLog.findMany({
        where: { actorUserId: admin.userId, action: { in: ['treasury.funding', 'treasury.withdrawal'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((row) => row.action)).toEqual(['treasury.funding', 'treasury.withdrawal']);
      expect(audits[1]?.detail).toMatchObject({ kind: 'DEBIT', amount: '400' });

      await http()
        .post('/api/admin/platform/treasury/withdrawal')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'USDT', amount: '999999', note: 'over the balance' })
        .expect(409);

      await http()
        .post('/api/admin/platform/treasury/withdrawal')
        .set(bearer(admin.token))
        .send({ assetSymbol: 'FOOBAR', amount: '1', note: 'ghost asset' })
        .expect(404);
    });
  });

  describe('asset lifecycle', () => {
    /** A suite-local asset row so the seeded INR/USDT/EMBER set is never touched. */
    async function createSuiteAsset(): Promise<{ id: string; symbol: string }> {
      const asset = await prisma.asset.create({
        data: {
          symbol: 'SUITE-TEST',
          name: 'Platform admin suite playground token',
          kind: AssetKind.TOKEN,
          decimals: 6,
        },
      });
      createdAssetIds.push(asset.id);
      return { id: asset.id, symbol: asset.symbol };
    }

    it('retires an asset, blocks its movements, restores it, and audits each flip', async () => {
      const admin = await createIdentity('asset-admin', { admin: true });
      const target = await createIdentity('asset-target');
      await createSuiteAsset();

      const retired = await http()
        .post('/api/admin/platform/assets/SUITE-TEST/status')
        .set(bearer(admin.token))
        .send({ isActive: false, note: 'Retiring the pilot token' })
        .expect(200);
      expect(retired.body).toMatchObject({ symbol: 'SUITE-TEST', isActive: false, kind: 'TOKEN' });

      const repository = await prisma.asset.findUnique({ where: { symbol: 'SUITE-TEST' } });
      expect(repository?.isActive).toBe(false);

      // The wallet layer refuses every movement against a retired asset.
      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'CREDIT', assetSymbol: 'SUITE-TEST', amount: '1', note: 'must not move' })
        .expect(409);

      await http()
        .post('/api/admin/platform/assets/SUITE-TEST/status')
        .set(bearer(admin.token))
        .send({ isActive: false, note: 'already retired' })
        .expect(409);

      const restored = await http()
        .post('/api/admin/platform/assets/suite-test/status')
        .set(bearer(admin.token))
        .send({ isActive: true, note: 'Pilot reopened' })
        .expect(200);
      expect(restored.body).toMatchObject({ symbol: 'SUITE-TEST', isActive: true });

      const audits = await prisma.adminAuditLog.findMany({
        where: { actorUserId: admin.userId, action: 'asset.status' },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(2);
      expect(audits[0]?.detail).toMatchObject({ asset: 'SUITE-TEST', to: false });
      expect(audits[1]?.detail).toMatchObject({ asset: 'SUITE-TEST', to: true });

      await http()
        .post('/api/admin/platform/assets/FOOBAR/status')
        .set(bearer(admin.token))
        .send({ isActive: false, note: 'ghost asset' })
        .expect(404);

      await http()
        .post('/api/admin/platform/assets/SUITE-TEST/status')
        .set(bearer(admin.token))
        .send({ isActive: false, note: '   ' })
        .expect(400);
    });
  });

  describe('platform overview and account detail (reads)', () => {
    it('refuses the read surface without a token, a non-admin and reports it for admins', async () => {
      await http().get('/api/admin/platform/overview').expect(401);

      const user = await createIdentity('overview-non-admin');
      await http().get('/api/admin/platform/overview').set(bearer(user.token)).expect(403);

      const admin = await createIdentity('overview-admin', { admin: true });
      const res = await http().get('/api/admin/platform/overview').set(bearer(admin.token)).expect(200);

      expect(res.body.users.total).toBeGreaterThanOrEqual(2);
      expect(typeof res.body.users.byStatus.ACTIVE).toBe('number');
      expect(res.body.wallets.total).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(res.body.roles)).toBe(true);

      const symbols = (res.body.assets as { symbol: string }[]).map((asset) => asset.symbol);
      expect(symbols).toEqual(expect.arrayContaining(['INR', 'USDT', 'EMBER']));
      const suiteAsset = (res.body.assets as { symbol: string }[]).find(
        (asset) => asset.symbol === 'SUITE-TEST',
      );
      expect(suiteAsset).toBeDefined();

      expect(res.body.treasury.provisioned).toBe(true);
      expect(typeof res.body.treasury.userId).toBe('string');
      for (const balance of res.body.treasury.balances) {
        expect(typeof balance.available).toBe('string');
      }
      expect(Array.isArray(res.body.recentAudit)).toBe(true);
    });

    it('returns a wallet-less account without inventing a wallet, 404 for a ghost', async () => {
      const admin = await createIdentity('detail-admin', { admin: true });
      const target = await createIdentity('detail-target');

      // The movement yields INR 2500 then debits 500, so the ledger keeps both legs.
      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'CREDIT', assetSymbol: 'INR', amount: '2500.00', note: 'Detail seed credit' })
        .expect(200);
      await http()
        .post(`/api/admin/platform/users/${target.userId}/wallet-movements`)
        .set(bearer(admin.token))
        .send({ kind: 'DEBIT', assetSymbol: 'INR', amount: '500.00', note: 'Detail seed debit' })
        .expect(200);

      const res = await http()
        .get(`/api/admin/platform/users/${target.userId}`)
        .set(bearer(admin.token))
        .expect(200);

      expect(res.body.user).toMatchObject({ id: target.userId, status: 'ACTIVE' });
      expect(res.body.roles).toEqual(['USER', 'EXPERT_TRADER']);
      expect(res.body.wallet).not.toBeNull();
      expect(res.body.wallet.id).toBeTruthy();
      expect(res.body.wallet.status).toBe('ACTIVE');
      const inr = (res.body.wallet.balances as { symbol: string; available: string }[]).find(
        (balance) => balance.symbol === 'INR',
      );
      expect(inr?.available).toBe('2000.00');
      const legs = res.body.wallet.ledger as { type: string; note: string | null }[];
      const adjustmentNotes = legs
        .filter((leg) => leg.type === 'ADJUSTMENT')
        .map((leg) => leg.note);
      expect(adjustmentNotes).toEqual(['Detail seed debit', 'Detail seed credit']);

      const walletless = await createIdentity('detail-walletless');
      const empty = await http()
        .get(`/api/admin/platform/users/${walletless.userId}`)
        .set(bearer(admin.token))
        .expect(200);
      expect(empty.body.wallet).toBeNull();

      await http()
        .get('/api/admin/platform/users/00000000-0000-0000-0000-00000000000e')
        .set(bearer(admin.token))
        .expect(404);
    });
  });
});

function noteOf(note: string | null): string {
  return note ?? '';
}
