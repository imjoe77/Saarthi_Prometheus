import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { mintToken } from './token-minting';

/**
 * MODULE 13 - role-based access control over HTTP.
 *
 * Boots the real application so the global AuthGuard, the global RolesGuard,
 * the real Prisma schema and the real audit log are all under test. Nothing
 * here is stubbed: a suite that passed against a mock would prove nothing
 * about the chain that has to hold.
 *
 * What is deliberately absent: any route an administrator can use to grant
 * PLATFORM_ADMIN. The HTTP admin API refuses that role by design, and a
 * PLATFORM_ADMIN role request is never queued for approval - the login funnel
 * auto-grants it only for an address listed in `PLATFORM_ADMIN_EMAILS`
 * (configuration, covered below), and every other path is the operator CLI
 * (`npm run grant:role`). This suite proves the refusals, not a secret grant
 * path.
 *
 * Isolation: every user created here carries a UUID in its email and is
 * removed in `afterAll` in FK-safe order, so the suite leaves nothing behind.
 *
 * The e2e setup grants EXPERT_TRADER to every authenticated caller (see
 * `test/setup-env.ts`) so frozen pre-RBAC suites keep working. Tests that
 * assert 403-forbidden for a non-expert revoke that role first, which is what
 * makes the negative cases meaningful rather than vacuous.
 */
describe('RBAC - roles, requests, admin and audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  const emailFor = (label: string) => `${label}-${randomUUID()}@rbac.test`;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Strategies are onDelete: Restrict on the owner, so they must go first;
    // the role tables and audit rows cascade with the user.
    await prisma.strategy.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } });
    }
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const http = () => request(app.getHttpServer());

  /** First login + AUTH_ADMIN bootstrap when requested. */
  async function login(
    label: string,
    options: { admin?: boolean } = {},
  ): Promise<{ token: string; userId: string; email: string; subject: string }> {
    const email = emailFor(label);
    const subject = `google:${label}-${randomUUID()}`;
    const token = await mintToken({ subject, email });
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

    return { token, userId, email, subject };
  }

  /**
   * A second token for an account that already exists, scoped to a persona.
   *
   * Same subject, so the backend resolves the same user; the only difference
   * is the `loginRole` claim the BFF would sign after `/login/continue`
   * recorded the visitor's card pick. This is exactly how the real flow
   * re-mints: one account, one intent, two possible sessions.
   */
  async function scopedToken(
    user: { subject: string; email: string },
    loginRole: string,
  ): Promise<string> {
    return mintToken({ subject: user.subject, email: user.email, extraClaims: { loginRole } });
  }

  /** Removes EXPERT_TRADER so a 403 path is meaningful under the test fixture. */
  async function revokeExpert(userId: string): Promise<void> {
    await prisma.userRole.deleteMany({ where: { userId, role: 'EXPERT_TRADER' } });
  }

  /**
   * Runs `fn` with the e2e fixture role suspended.
   *
   * The fixture re-grants EXPERT_TRADER on every authenticated request, so a
   * revocation made through Prisma would be undone by the next resolveIdentity
   * - the negative request would arrive already privileged and RolesGuard
   * would never refuse it. Suspending the env var for exactly the requests
   * under test is what makes "revoked role" observable; it is restored in a
   * `finally` so a failed assertion cannot leak into later tests.
   */
  async function withoutFixture<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env['RBAC_TEST_DEFAULT_ROLES'];
    delete process.env['RBAC_TEST_DEFAULT_ROLES'];
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env['RBAC_TEST_DEFAULT_ROLES'];
      else process.env['RBAC_TEST_DEFAULT_ROLES'] = saved;
    }
  }

  // -------------------------------------------------------------------------
  // Unauthenticated default
  // -------------------------------------------------------------------------

  describe('when no usable token is present', () => {
    it('refuses /rbac/me', async () => {
      await http().get('/api/rbac/me').expect(401);
    });

    it('refuses /rbac/role-requests', async () => {
      await http().post('/api/rbac/role-requests').send({ role: 'EXPERT_TRADER' }).expect(401);
    });

    it('refuses the admin user list', async () => {
      await http().get('/api/admin/users').expect(401);
    });

    it('refuses profile reads', async () => {
      await http().get('/api/profile/me').expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Role discovery
  // -------------------------------------------------------------------------

  describe('GET /rbac/me', () => {
    it('returns the caller’s roles and requestable roles', async () => {
      const user = await login('roles-me');
      const res = await http().get('/api/rbac/me').set(bearer(user.token)).expect(200);

      expect(res.body).toMatchObject({ userId: user.userId });
      expect(res.body.roles).toEqual(expect.arrayContaining(['USER', 'EXPERT_TRADER']));
      // EXPERT_TRADER is held under the test fixture, so only LIQUIDITY_PROVIDER
      // remains requestable.
      expect(res.body.requestable).toEqual(['LIQUIDITY_PROVIDER']);
    });

    it('lists both requestable roles for a user who holds neither privileged role', async () => {
      const user = await login('roles-me-none');
      await revokeExpert(user.userId);

      const res = await withoutFixture(() =>
        http().get('/api/rbac/me').set(bearer(user.token)).expect(200),
      );
      expect(res.body.roles).toEqual(['USER']);
      expect(res.body.requestable).toEqual(['EXPERT_TRADER', 'LIQUIDITY_PROVIDER']);
    });

    it('does not change the frozen /auth/me response shape', async () => {
      const user = await login('roles-auth-me');
      const res = await http().get('/api/auth/me').set(bearer(user.token)).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'provider', 'status']);
      expect(res.body).not.toHaveProperty('roles');
    });
  });

  // -------------------------------------------------------------------------
  // Session-scoped active role (the login-intent claim)
  // -------------------------------------------------------------------------

  describe('a session signed in as one persona', () => {
    it('narrows a multi-role account to USER while reporting the full grant set', async () => {
      // The bug this feature exists to fix: an account holding USER +
      // EXPERT_TRADER (+ the fixture grant) that picks the Normal User card
      // must be a normal user for the whole session.
      const user = await login('scope-user');
      const token = await scopedToken(user, 'USER');

      const res = await http().get('/api/rbac/me').set(bearer(token)).expect(200);

      expect(res.body.roles).toEqual(['USER']);
      expect(res.body.activeRole).toBe('USER');
      // The account still owns EXPERT_TRADER - what it owns and what this
      // session acts as are two different questions, and both are answered.
      expect(res.body.heldRoles).toEqual(expect.arrayContaining(['USER', 'EXPERT_TRADER']));
      // Requestable is computed from held, so a role the account already owns
      // never looks requestable again just because of the persona chosen.
      expect(res.body.requestable).toEqual(['LIQUIDITY_PROVIDER']);
    });

    it('refuses an expert route for a USER-scoped session that holds EXPERT_TRADER', async () => {
      const user = await login('scope-refuse');
      const scoped = await scopedToken(user, 'USER');

      // Same account, same fixture-granted EXPERT_TRADER: the unscoped token
      // succeeds...
      await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: `Strategy-${randomUUID()}`, description: 'unscoped ok' })
        .expect(201);

      // ...and the session that signed in as a normal user is refused by the
      // global RolesGuard. Narrowing is enforced server-side, not in the UI.
      const res = await http()
        .post('/api/strategies')
        .set(bearer(scoped))
        .send({ name: `Strategy-${randomUUID()}`, description: 'scoped refused' })
        .expect(403);

      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('allows the expert route for a session signed in as EXPERT_TRADER', async () => {
      const user = await login('scope-expert');
      const scoped = await scopedToken(user, 'EXPERT_TRADER');

      const res = await http()
        .post('/api/strategies')
        .set(bearer(scoped))
        .send({ name: `Strategy-${randomUUID()}`, description: 'scoped expert ok' })
        .expect(201);

      const row = await prisma.strategy.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.ownerId).toBe(user.userId);
    });

    it('narrows an admin persona-scoped to USER off the admin surface', async () => {
      // One click, one surface: the admin card is the only way to reach the
      // admin surface, so an admin who picks Normal User is a normal user for
      // the whole session — the admin API refuses them.
      const admin = await login('scope-admin', { admin: true });
      const scoped = await scopedToken(admin, 'USER');

      const res = await http().get('/api/rbac/me').set(bearer(scoped)).expect(200);
      expect(res.body.roles).toEqual(['USER']);
      expect(res.body.activeRole).toBe('USER');
      expect(res.body.heldRoles).toEqual(
        expect.arrayContaining(['USER', 'PLATFORM_ADMIN']),
      );

      await http().get('/api/treasury/summary').set(bearer(scoped)).expect(403);
    });

    it('scopes an admin session to the admin surface when the admin card was clicked', async () => {
      // The other half of the same rule: PLATFORM_ADMIN is a persona like any
      // other, and clicking its card yields exactly that surface — no more.
      const admin = await login('scope-admin-persona', { admin: true });
      const scoped = await scopedToken(admin, 'PLATFORM_ADMIN');

      const res = await http().get('/api/rbac/me').set(bearer(scoped)).expect(200);
      expect(res.body.roles).toEqual(['PLATFORM_ADMIN']);
      expect(res.body.activeRole).toBe('PLATFORM_ADMIN');

      await http().get('/api/treasury/summary').set(bearer(scoped)).expect(200);
    });

    it('reads the persona for every role the login page offers, not just USER', async () => {
      const user = await login('scope-lp');
      // This account genuinely holds the LP grant (as an approved request
      // would), so the scoping below is a narrowing, not a widening.
      await prisma.userRole.upsert({
        where: { userId_role: { userId: user.userId, role: 'LIQUIDITY_PROVIDER' } },
        create: { userId: user.userId, role: 'LIQUIDITY_PROVIDER' },
        update: {},
      });
      const scoped = await scopedToken(user, 'LIQUIDITY_PROVIDER');

      const res = await http().get('/api/rbac/me').set(bearer(scoped)).expect(200);

      expect(res.body.roles).toEqual(['LIQUIDITY_PROVIDER']);
      expect(res.body.activeRole).toBe('LIQUIDITY_PROVIDER');
      // EXPERT_TRADER is still held (fixture), so it is not requestable, while
      // the scope is real: this session is not an expert session even though
      // the account is - the guard refuses the expert route below.
      expect(res.body.requestable).toEqual([]);
      expect(res.body.heldRoles).toEqual(expect.arrayContaining(['EXPERT_TRADER']));

      await http()
        .post('/api/strategies')
        .set(bearer(scoped))
        .send({ name: `Strategy-${randomUUID()}`, description: 'lp is not expert' })
        .expect(403);
    });

    it('never widens: a persona the account does not hold grants nothing', async () => {
      const user = await login('scope-widen');
      await revokeExpert(user.userId);
      const scoped = await scopedToken(user, 'EXPERT_TRADER');

      const res = await withoutFixture(() =>
        http().get('/api/rbac/me').set(bearer(scoped)).expect(200),
      );

      // Intersection only: holding USER while claiming EXPERT_TRADER yields the
      // empty set, never a conjured expert session.
      expect(res.body.roles).toEqual([]);
      expect(res.body.heldRoles).toEqual(['USER']);
      expect(res.body.activeRole).toBe('EXPERT_TRADER');
      expect(res.body.requestable).toEqual(['EXPERT_TRADER', 'LIQUIDITY_PROVIDER']);

      // And the guard agrees with the empty set.
      await withoutFixture(() =>
        http()
          .post('/api/strategies')
          .set(bearer(scoped))
          .send({ name: `Strategy-${randomUUID()}`, description: 'nope' })
          .expect(403),
      );
    });

    it('narrows a non-admin account claiming PLATFORM_ADMIN to nothing at all', async () => {
      // The claim is a persona hint, not a grant: an account with no
      // PLATFORM_ADMIN row intersects to the empty set and reaches nothing —
      // it never becomes an admin session by assertion.
      const user = await login('scope-admin-claim');
      await revokeExpert(user.userId);
      const forged = await scopedToken(user, 'PLATFORM_ADMIN');

      const res = await withoutFixture(() =>
        http().get('/api/rbac/me').set(bearer(forged)).expect(200),
      );

      expect(res.body.activeRole).toBe('PLATFORM_ADMIN');
      expect(res.body.roles).toEqual([]);
      expect(res.body.heldRoles).toEqual(['USER']);
      // And the guard agrees with the empty set.
      await withoutFixture(() =>
        http().get('/api/treasury/summary').set(bearer(forged)).expect(403),
      );
    });

    it.each([
      ['an unknown role name', 'SUPERUSER'],
      ['a lowercased role name', 'expert_trader'],
      ['a non-string value', 42],
    ])('treats %s in the claim as no active role rather than failing the request', async (
      _label,
      value,
    ) => {
      const user = await login('scope-garbage');
      const token = await mintToken({
        subject: user.subject,
        email: user.email,
        extraClaims: { loginRole: value },
      });

      const res = await http().get('/api/rbac/me').set(bearer(token)).expect(200);

      expect(res.body.activeRole).toBeNull();
      expect(res.body.roles).toEqual(expect.arrayContaining(['USER', 'EXPERT_TRADER']));
    });

    it('keeps a pre-scoping session (no claim) at every held role', async () => {
      // Backward compatibility: a session created before the feature existed
      // carries no claim and must behave exactly as it did before.
      const user = await login('scope-old-session');
      const res = await http().get('/api/rbac/me').set(bearer(user.token)).expect(200);

      expect(res.body.activeRole).toBeNull();
      expect(res.body.roles).toEqual(expect.arrayContaining(['USER', 'EXPERT_TRADER']));
    });
  });

  // -------------------------------------------------------------------------
  // Self-serve role requests
  // -------------------------------------------------------------------------

  describe('POST /rbac/role-requests', () => {
    it('creates a pending EXPERT_TRADER request', async () => {
      const user = await login('request-expert');
      await revokeExpert(user.userId);

      const res = await withoutFixture(() =>
        http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER', note: 'I want to publish strategies.' })
          .expect(201),
      );

      const stored = await prisma.roleRequest.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(stored).toMatchObject({ userId: user.userId, role: 'EXPERT_TRADER', status: 'PENDING' });
      expect(stored.note).toBe('I want to publish strategies.');
    });

    it('creates a pending LIQUIDITY_PROVIDER request', async () => {
      const user = await login('request-lp');
      await revokeExpert(user.userId);

      // Isolated from the fixture: with EXPERT_TRADER present the one-role
      // rule would refuse this request before the queue ever saw it.
      const res = await withoutFixture(() =>
        http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'LIQUIDITY_PROVIDER' })
          .expect(201),
      );

      const stored = await prisma.roleRequest.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(stored).toMatchObject({ userId: user.userId, role: 'LIQUIDITY_PROVIDER', status: 'PENDING' });
    });

    it('refuses a request for PLATFORM_ADMIN unless the address is env-listed', async () => {
      const user = await login('request-admin');
      await revokeExpert(user.userId);

      // Admin is configuration-only: without a PLATFORM_ADMIN_EMAILS listing
      // the request is refused outright rather than queued, so the approval
      // queue can never be the path to an admin grant.
      const refused = await withoutFixture(() =>
        http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'PLATFORM_ADMIN' })
          .expect(403),
      );
      expect(refused.body.code).toBe('FORBIDDEN');

      const queued = await prisma.roleRequest.findFirst({
        where: { userId: user.userId, role: 'PLATFORM_ADMIN' },
      });
      expect(queued).toBeNull();

      const granted = await prisma.userRole.findUnique({
        where: { userId_role: { userId: user.userId, role: 'PLATFORM_ADMIN' } },
      });
      expect(granted).toBeNull();
    });

    it('auto-approves PLATFORM_ADMIN for an env-listed address', async () => {
      const user = await login('request-admin-allowed');
      await revokeExpert(user.userId);
      const previous = process.env['PLATFORM_ADMIN_EMAILS'];
      process.env['PLATFORM_ADMIN_EMAILS'] = user.email;

      try {
        const res = await withoutFixture(() =>
          http()
            .post('/api/rbac/role-requests')
            .set(bearer(user.token))
            .send({ role: 'PLATFORM_ADMIN' })
            .expect(201),
        );

        const stored = await prisma.roleRequest.findUniqueOrThrow({ where: { id: res.body.id } });
        expect(stored).toMatchObject({ userId: user.userId, role: 'PLATFORM_ADMIN', status: 'APPROVED' });

        const granted = await prisma.userRole.findUnique({
          where: { userId_role: { userId: user.userId, role: 'PLATFORM_ADMIN' } },
        });
        expect(granted).not.toBeNull();
        // Configuration granted it, so there is no human approver to name.
        expect(granted?.grantedBy).toBeNull();
      } finally {
        if (previous === undefined) {
          delete process.env['PLATFORM_ADMIN_EMAILS'];
        } else {
          process.env['PLATFORM_ADMIN_EMAILS'] = previous;
        }
      }

      await prisma.userRole.deleteMany({
        where: { userId: user.userId, role: 'PLATFORM_ADMIN' },
      });
    });

    it('rejects a duplicate pending request for the same role', async () => {
      const user = await login('request-duplicate');
      await revokeExpert(user.userId);

      await withoutFixture(async () => {
        await http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201);

        const second = await http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(409);

        expect(second.body.code).toBe('CONFLICT');
      });
    });

    it('lists the caller’s own request history', async () => {
      const user = await login('request-history');
      await revokeExpert(user.userId);

      await withoutFixture(async () => {
        await http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201);

        const res = await http()
          .get('/api/rbac/role-requests/me')
          .set(bearer(user.token))
          .expect(200);

        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ role: 'EXPERT_TRADER', status: 'PENDING' });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Admin surface
  // -------------------------------------------------------------------------

  describe('admin endpoints', () => {
    it('refuses a non-admin caller on the user list with 403', async () => {
      const user = await login('admin-users-nonadmin');
      const res = await http().get('/api/admin/users').set(bearer(user.token)).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('lists users with roles for an admin', async () => {
      const admin = await login('admin-users', { admin: true });
      const res = await http().get('/api/admin/users').set(bearer(admin.token)).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const self = res.body.find((entry: { id: string }) => entry.id === admin.userId);
      expect(self).toMatchObject({ id: admin.userId, email: admin.email });
      expect(self.roles).toEqual(expect.arrayContaining(['USER', 'PLATFORM_ADMIN']));
    });

    it('grants EXPERT_TRADER to a target user and writes an audit row', async () => {
      const admin = await login('admin-grant', { admin: true });
      const target = await login('admin-grant-target');
      await revokeExpert(target.userId);

      await http()
        .post(`/api/admin/users/${target.userId}/roles`)
        .set(bearer(admin.token))
        .send({ role: 'EXPERT_TRADER' })
        .expect(204);

      const granted = await prisma.userRole.findUnique({
        where: { userId_role: { userId: target.userId, role: 'EXPERT_TRADER' } },
      });
      expect(granted).not.toBeNull();

      const audit = await prisma.adminAuditLog.findFirst({
        where: { actorUserId: admin.userId, action: 'role.grant', targetUserId: target.userId },
      });
      expect(audit).not.toBeNull();
      expect(audit?.detail).toMatchObject({ role: 'EXPERT_TRADER' });
    });

    it('revokes EXPERT_TRADER and writes an audit row', async () => {
      const admin = await login('admin-revoke', { admin: true });
      const target = await login('admin-revoke-target');

      await http()
        .delete(`/api/admin/users/${target.userId}/roles/EXPERT_TRADER`)
        .set(bearer(admin.token))
        .expect(204);

      const revoked = await prisma.userRole.findUnique({
        where: { userId_role: { userId: target.userId, role: 'EXPERT_TRADER' } },
      });
      expect(revoked).toBeNull();

      const audit = await prisma.adminAuditLog.findFirst({
        where: { actorUserId: admin.userId, action: 'role.revoke', targetUserId: target.userId },
      });
      expect(audit).not.toBeNull();
    });

    it('refuses to grant PLATFORM_ADMIN through the API', async () => {
      const admin = await login('admin-refuse-platform', { admin: true });
      const target = await login('admin-refuse-platform-target');

      const res = await http()
        .post(`/api/admin/users/${target.userId}/roles`)
        .set(bearer(admin.token))
        .send({ role: 'PLATFORM_ADMIN' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');

      const granted = await prisma.userRole.findUnique({
        where: { userId_role: { userId: target.userId, role: 'PLATFORM_ADMIN' } },
      });
      expect(granted).toBeNull();
    });

    it('refuses to revoke the baseline USER role', async () => {
      const admin = await login('admin-revoke-user', { admin: true });
      const target = await login('admin-revoke-user-target');

      const res = await http()
        .delete(`/api/admin/users/${target.userId}/roles/USER`)
        .set(bearer(admin.token))
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');

      const still = await prisma.userRole.findUnique({
        where: { userId_role: { userId: target.userId, role: 'USER' } },
      });
      expect(still).not.toBeNull();
    });

    it('approves a role request and grants the role atomically', async () => {
      const admin = await login('admin-approve', { admin: true });
      const requester = await login('admin-approve-requester');
      await revokeExpert(requester.userId);

      const created = await withoutFixture(() =>
        http()
          .post('/api/rbac/role-requests')
          .set(bearer(requester.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201),
      );

      await http()
        .post(`/api/admin/role-requests/${created.body.id}/decision`)
        .set(bearer(admin.token))
        .send({ decision: 'APPROVED' })
        .expect(204);

      const role = await prisma.userRole.findUnique({
        where: { userId_role: { userId: requester.userId, role: 'EXPERT_TRADER' } },
      });
      expect(role).not.toBeNull();

      const decided = await prisma.roleRequest.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(decided.status).toBe('APPROVED');
      expect(decided.decidedBy).toBe(admin.userId);
      expect(decided.decidedAt).not.toBeNull();
    });

    it('rejects a role request without granting the role', async () => {
      const admin = await login('admin-reject', { admin: true });
      const requester = await login('admin-reject-requester');
      await revokeExpert(requester.userId);

      // Isolated from the fixture: a fixture-granted EXPERT_TRADER would make
      // the one-role rule refuse this LP request before it ever queued.
      const created = await withoutFixture(() =>
        http()
          .post('/api/rbac/role-requests')
          .set(bearer(requester.token))
          .send({ role: 'LIQUIDITY_PROVIDER' })
          .expect(201),
      );

      await http()
        .post(`/api/admin/role-requests/${created.body.id}/decision`)
        .set(bearer(admin.token))
        .send({ decision: 'REJECTED' })
        .expect(204);

      const role = await prisma.userRole.findUnique({
        where: { userId_role: { userId: requester.userId, role: 'LIQUIDITY_PROVIDER' } },
      });
      expect(role).toBeNull();

      const decided = await prisma.roleRequest.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(decided.status).toBe('REJECTED');
    });

    it('refuses to decide an already-decided request', async () => {
      const admin = await login('admin-decide-twice', { admin: true });
      const requester = await login('admin-decide-twice-requester');
      await revokeExpert(requester.userId);

      const created = await withoutFixture(() =>
        http()
          .post('/api/rbac/role-requests')
          .set(bearer(requester.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201),
      );

      await http()
        .post(`/api/admin/role-requests/${created.body.id}/decision`)
        .set(bearer(admin.token))
        .send({ decision: 'APPROVED' })
        .expect(204);

      const second = await http()
        .post(`/api/admin/role-requests/${created.body.id}/decision`)
        .set(bearer(admin.token))
        .send({ decision: 'REJECTED' })
        .expect(409);

      expect(second.body.code).toBe('CONFLICT');
    });

    it('lists the request queue for an admin', async () => {
      const admin = await login('admin-queue', { admin: true });
      const requester = await login('admin-queue-requester');
      await revokeExpert(requester.userId);

      await withoutFixture(() =>
        http()
          .post('/api/rbac/role-requests')
          .set(bearer(requester.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201),
      );

      const res = await http()
        .get('/api/admin/role-requests?status=PENDING')
        .set(bearer(admin.token))
        .expect(200);

      expect(res.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'EXPERT_TRADER', status: 'PENDING' }),
        ]),
      );
    });

    it('returns the audit trail to an admin and refuses everyone else', async () => {
      const admin = await login('admin-audit', { admin: true });
      const nonAdmin = await login('admin-audit-nonadmin');

      await http().get('/api/admin/audit-logs').set(bearer(nonAdmin.token)).expect(403);

      const res = await http().get('/api/admin/audit-logs').set(bearer(admin.token)).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Authorization matrix on gated routes
  // -------------------------------------------------------------------------

  describe('gated routes', () => {
    it('refuses strategy creation for a caller without EXPERT_TRADER', async () => {
      const user = await login('gate-strategy-create');
      await revokeExpert(user.userId);

      const res = await withoutFixture(() =>
        http()
          .post('/api/strategies')
          .set(bearer(user.token))
          .send({ name: `Strategy-${randomUUID()}`, description: 'nope' })
          .expect(403),
      );

      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('allows strategy creation for an EXPERT_TRADER', async () => {
      const user = await login('gate-strategy-create-ok');

      const res = await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: `Strategy-${randomUUID()}`, description: 'yes' })
        .expect(201);

      // The frozen create response does not echo ownerId; ownership is the
      // thing worth proving, so it is read from the row the write produced.
      expect(res.body).toMatchObject({ id: expect.any(String), status: 'ACTIVE' });
      const row = await prisma.strategy.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.ownerId).toBe(user.userId);
    });

    it('refuses strategy list-me for a caller without EXPERT_TRADER', async () => {
      const user = await login('gate-strategy-me');
      await revokeExpert(user.userId);

      await withoutFixture(() =>
        http().get('/api/strategies/me').set(bearer(user.token)).expect(403),
      );
    });

    it('allows strategy list-me for an EXPERT_TRADER', async () => {
      const user = await login('gate-strategy-me-ok');
      await http().get('/api/strategies/me').set(bearer(user.token)).expect(200);
    });

    it('refuses treasury summary for a non-admin', async () => {
      const user = await login('gate-treasury');
      const res = await http().get('/api/treasury/summary').set(bearer(user.token)).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('allows treasury summary for a PLATFORM_ADMIN', async () => {
      const admin = await login('gate-treasury-admin', { admin: true });
      await http().get('/api/treasury/summary').set(bearer(admin.token)).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // Profile and onboarding
  // -------------------------------------------------------------------------

  describe('profile and onboarding', () => {
    it('returns an all-null profile before any answers', async () => {
      const user = await login('profile-empty');
      const res = await http().get('/api/profile/me').set(bearer(user.token)).expect(200);

      expect(res.body).toMatchObject({
        displayName: null,
        country: null,
        riskTolerance: null,
        onboardingCompletedAt: null,
      });
    });

    it('updates a partial profile', async () => {
      const user = await login('profile-partial');

      await http()
        .put('/api/profile/me')
        .set(bearer(user.token))
        .send({ displayName: 'Alice', country: 'US', riskTolerance: 'BALANCED' })
        .expect(200);

      const res = await http().get('/api/profile/me').set(bearer(user.token)).expect(200);
      expect(res.body).toMatchObject({
        displayName: 'Alice',
        country: 'US',
        riskTolerance: 'BALANCED',
        primaryGoal: null,
      });
    });

    it('rejects an invalid country code', async () => {
      const user = await login('profile-bad-country');
      const res = await http()
        .put('/api/profile/me')
        .set(bearer(user.token))
        .send({ country: 'NOT_A_COUNTRY' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses onboarding completion until the core answers exist', async () => {
      const user = await login('profile-onboarding-incomplete');

      const res = await http()
        .post('/api/profile/me/onboarding/complete')
        .set(bearer(user.token))
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.message).toContain('Still needed');
    });

    it('completes onboarding once the core answers exist, idempotently', async () => {
      const user = await login('profile-onboarding-complete');

      await http()
        .put('/api/profile/me')
        .set(bearer(user.token))
        .send({
          experienceLevel: 'INTERMEDIATE',
          investmentCapitalRange: '50K_250K',
          capitalAvailability: 'MEDIUM_TERM',
          riskTolerance: 'BALANCED',
          drawdownComfort: 'MODERATE',
          volatilityComfort: 'MEDIUM',
          primaryGoal: 'GROWTH',
          timeHorizon: '1_3_YEARS',
          expectedReturnRange: 'MODERATE',
          holdingPeriod: 'MEDIUM_TERM',
          lossReaction: 'HOLD',
          liquidityNeeds: 'MEDIUM',
          contributionFrequency: 'MONTHLY',
        })
        .expect(200);

      const first = await http()
        .post('/api/profile/me/onboarding/complete')
        .set(bearer(user.token))
        .expect(200);

      expect(first.body.onboardingCompletedAt).toEqual(expect.any(String));

      const second = await http()
        .post('/api/profile/me/onboarding/complete')
        .set(bearer(user.token))
        .expect(200);

      expect(second.body.onboardingCompletedAt).toBe(first.body.onboardingCompletedAt);
    });
  });

  // -------------------------------------------------------------------------
  // Self-promotion is impossible over HTTP
  // -------------------------------------------------------------------------

  describe('self-promotion refusal', () => {
    it('a normal user cannot grant themselves any role', async () => {
      const user = await login('self-promotion');
      await revokeExpert(user.userId);

      // No user-role mutation exists for a normal caller: the only HTTP grant
      // path is the admin API, which is already refused above for non-admins.
      // Suspended fixture so the refusal does not re-grant on the way in.
      await withoutFixture(async () => {
        await http()
          .post(`/api/admin/users/${user.userId}/roles`)
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(403);

        await http()
          .post(`/api/admin/users/${user.userId}/roles`)
          .set(bearer(user.token))
          .send({ role: 'PLATFORM_ADMIN' })
          .expect(403);
      });

      const roles = await prisma.userRole.findMany({ where: { userId: user.userId } });
      expect(roles.map((row) => row.role).sort()).toEqual(['USER']);
    });
  });

  // -------------------------------------------------------------------------
  // Email allowlist authorization (Module 13)
  //
  // The allowlist lives in the environment and is read at request time, so
  // these tests toggle it directly. The fixture's default EXPERT_TRADER grant
  // is suspended throughout: what is under test is self-authorization, not
  // the fixture.
  // -------------------------------------------------------------------------

  describe('email allowlist authorization', () => {
    it('refuses /rbac/authorize without a token', async () => {
      await http().get('/api/rbac/authorize').query({ role: 'EXPERT_TRADER' }).expect(401);
    });

    it('denies a non-allowlisted email and keeps its request PENDING', async () => {
      const user = await login('allowlist-denied');
      await revokeExpert(user.userId);

      await withoutFixture(async () => {
        const denied = await http()
          .get('/api/rbac/authorize')
          .query({ role: 'EXPERT_TRADER' })
          .set(bearer(user.token))
          .expect(200);
        expect(denied.body).toEqual({ role: 'EXPERT_TRADER', authorized: false });

        const created = await http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201);

        const stored = await prisma.roleRequest.findUniqueOrThrow({
          where: { id: created.body.id as string },
        });
        expect(stored).toMatchObject({
          userId: user.userId,
          role: 'EXPERT_TRADER',
          status: 'PENDING',
        });
      });
    });

    it('authorizes and auto-grants an allowlisted email, converting its PENDING request', async () => {
      const user = await login('allowlist-authorized');
      await revokeExpert(user.userId);

      await withoutFixture(async () => {
        // The request exists before the address is authorized: the flow must
        // resume it rather than fail with the duplicate conflict.
        const created = await http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201);

        const saved = process.env['EXPERT_TRADER_EMAILS'];
        process.env['EXPERT_TRADER_EMAILS'] = user.email;
        try {
          const allowed = await http()
            .get('/api/rbac/authorize')
            .query({ role: 'EXPERT_TRADER' })
            .set(bearer(user.token))
            .expect(200);
          expect(allowed.body).toEqual({ role: 'EXPERT_TRADER', authorized: true });

          const granted = await http()
            .post('/api/rbac/role-requests')
            .set(bearer(user.token))
            .send({ role: 'EXPERT_TRADER' })
            .expect(201);
          expect(granted.body.id).toBe(created.body.id);

          const request = await prisma.roleRequest.findUniqueOrThrow({
            where: { id: granted.body.id as string },
          });
          expect(request).toMatchObject({ role: 'EXPERT_TRADER', status: 'APPROVED' });
          expect(request.decidedAt).toEqual(expect.any(Date));

          const grantedRole = await prisma.userRole.findUniqueOrThrow({
            where: { userId_role: { userId: user.userId, role: 'EXPERT_TRADER' } },
          });
          expect(grantedRole).toMatchObject({ userId: user.userId, role: 'EXPERT_TRADER' });

          const audit = await prisma.adminAuditLog.findFirst({
            where: { actorUserId: user.userId, action: 'role_request.approve' },
            orderBy: { createdAt: 'desc' },
          });
          expect(audit).not.toBeNull();
          expect(audit?.detail).toMatchObject({ role: 'EXPERT_TRADER', via: 'email-allowlist' });

          const me = await http().get('/api/rbac/me').set(bearer(user.token)).expect(200);
          expect(me.body.roles).toContain('EXPERT_TRADER');
        } finally {
          if (saved === undefined) delete process.env['EXPERT_TRADER_EMAILS'];
          else process.env['EXPERT_TRADER_EMAILS'] = saved;
        }
      });
    });

    it('never self-authorizes PLATFORM_ADMIN without the env listing', async () => {
      // The admin card routes through the same authorize endpoint as every
      // other elevated persona, but the allowlist is empty by default: an
      // address nobody listed is refused, with the plain shape (no reason —
      // nothing is *wrong*, the configuration simply does not name it).
      const user = await login('allowlist-refused');
      await revokeExpert(user.userId);

      const refused = await withoutFixture(() =>
        http()
          .get('/api/rbac/authorize')
          .query({ role: 'PLATFORM_ADMIN' })
          .set(bearer(user.token))
          .expect(200),
      );
      expect(refused.body).toEqual({ role: 'PLATFORM_ADMIN', authorized: false });
    });

    it('refuses an elevated request from an account that already holds a different one, with a reason', async () => {
      // The one-privileged-role rule, seen from the login funnel: this account
      // holds EXPERT_TRADER (fixture), so every other elevated persona is out
      // of reach and the refusal names the roles involved rather than giving a
      // generic allowlist answer.
      const user = await login('allowlist-one-role');
      const held = await http().get('/api/rbac/me').set(bearer(user.token)).expect(200);
      expect(held.body.heldRoles).toContain('EXPERT_TRADER');

      for (const role of ['LIQUIDITY_PROVIDER', 'PLATFORM_ADMIN']) {
        const refused = await http()
          .get('/api/rbac/authorize')
          .query({ role })
          .set(bearer(user.token))
          .expect(200);

        expect(refused.body.role).toBe(role);
        expect(refused.body.authorized).toBe(false);
        expect(refused.body.reason).toContain('Expert Trader');
        expect(refused.body.reason).toContain('Try a different account');
      }

      // And the request path refuses for the same reason, before the
      // allowlist is even consulted.
      const res = await http()
        .post('/api/rbac/role-requests')
        .set(bearer(user.token))
        .send({ role: 'LIQUIDITY_PROVIDER' })
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.message).toContain('Try a different account');
    });

    it('lets an allowlisted email clear a stale PENDING request left from before it was listed', async () => {
      // Regression: a request submitted while the address was NOT yet on the
      // allowlist legitimately queued for admin approval. Once the operator
      // lists the address, that configuration - not the stale queue entry -
      // must decide. The allowlist is evaluated ahead of the pending-conflict,
      // so the next request from an allowlisted address adopts and approves
      // its own pending row instead of being refused with CONFLICT.
      const user = await login('allowlist-stale-pending');
      await revokeExpert(user.userId);

      await withoutFixture(async () => {
        // PENDING while the address is not allowlisted (env unset for this test).
        const queued = await http()
          .post('/api/rbac/role-requests')
          .set(bearer(user.token))
          .send({ role: 'EXPERT_TRADER' })
          .expect(201);
        expect(
          (
            await prisma.roleRequest.findUniqueOrThrow({
              where: { id: queued.body.id as string },
            })
          ).status,
        ).toBe('PENDING');

        const saved = process.env['EXPERT_TRADER_EMAILS'];
        process.env['EXPERT_TRADER_EMAILS'] = user.email;
        try {
          // Without the ordering fix this second POST threw CONFLICT (409) and
          // the grant never fired, leaving the address stuck awaiting approval.
          const granted = await http()
            .post('/api/rbac/role-requests')
            .set(bearer(user.token))
            .send({ role: 'EXPERT_TRADER' })
            .expect(201);
          expect(granted.body.id).toBe(queued.body.id);

          const request = await prisma.roleRequest.findUniqueOrThrow({
            where: { id: queued.body.id as string },
          });
          expect(request).toMatchObject({ status: 'APPROVED' });

          const grantedRole = await prisma.userRole.findUniqueOrThrow({
            where: { userId_role: { userId: user.userId, role: 'EXPERT_TRADER' } },
          });
          expect(grantedRole).toMatchObject({ userId: user.userId, role: 'EXPERT_TRADER' });

          const me = await http().get('/api/rbac/me').set(bearer(user.token)).expect(200);
          expect(me.body.heldRoles).toContain('EXPERT_TRADER');
          expect(me.body.requestable).not.toContain('EXPERT_TRADER');
        } finally {
          if (saved === undefined) delete process.env['EXPERT_TRADER_EMAILS'];
          else process.env['EXPERT_TRADER_EMAILS'] = saved;
        }
      });
    });
  });
});
