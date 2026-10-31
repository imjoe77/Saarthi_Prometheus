import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/database/prisma.service';
import { mintToken } from './token-minting';

/**
 * MODULE 02 - authentication over HTTP.
 *
 * Boots the real application through the real `createApp()`, signs tokens with a
 * keypair generated for this run, and lets the real guard, the real verifier and
 * the real Prisma client do the work. Nothing is stubbed: a test that passed
 * against a mock would prove nothing about the chain that actually has to hold.
 *
 * What is deliberately absent: no OAuth. Google and GitHub redirect handling
 * lives in the Next.js app, and this service never sees a provider redirect.
 * These tests start where the BFF starts - with a correctly signed bearer token.
 *
 * Isolation: every user created here carries a UUID in its email and is removed
 * in `afterAll`, so the suite leaves nothing behind and does not truncate tables
 * that a developer may have seeded.
 */
describe('Authentication (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  const emailFor = (label: string) => `${label}-${randomUUID()}@auth.test`;

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // auth_accounts cascade from users, so removing the users removes the
    // identities. Ordered after all tests because several assert on this data.
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } });
    }
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  /** Mints a token for a brand new provider login and remembers the user. */
  async function firstLogin(subject: string, email: string): Promise<{ token: string; userId: string }> {
    const token = await mintToken({ subject, email });
    const response = await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id };
  }

  beforeEach(() => {
    // Auth failure paths log a warning by design (the reason code is useful
    // to an operator). Silence it so the suite output stays readable; the
    // behaviour is asserted separately.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // The unauthenticated default
  // -------------------------------------------------------------------------

  describe('when no usable token is present', () => {
    it('refuses a protected route outright', async () => {
      const response = await http().get('/api/auth/me').expect(401);

      expect(response.body).toMatchObject({ code: expect.any(String) });
    });

    it.each([
      ['no Authorization header at all', undefined],
      ['an empty header', ''],
      ['a scheme with no value', 'Bearer '],
      ['the wrong scheme', 'Basic YWJjOmRlZg=='],
      ['a raw token with no scheme', 'eyJhbGciOiJSUzI1NiJ9.eA.dGVzdA'],
      ['two spaces between scheme and value', 'Bearer  eyJhbGciOiJSUzI1NiJ9.eA.dGVzdA'],
    ])('refuses a request carrying %s', async (_label, header) => {
      const call = http().get('/api/auth/me');
      if (header !== undefined) call.set('Authorization', header);

      await call.expect(401);
    });

    it('never reveals whether a token was merely wrong or merely expired', async () => {
      const expired = await mintToken({ expiresIn: '-1h' });
      const garbage = 'not.a.token';

      const responses = await Promise.all(
        [expired, garbage].map((token) =>
          http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401),
        ),
      );

      // Same code and message: telling the two apart is free reconnaissance.
      // `requestId` and `timestamp` are per-request by design, so they are
      // excluded - they identify the request, not the failure.
      const comparable = (body: unknown) => {
        const { code, message } = body as { code: string; message: string };
        return { code, message };
      };
      expect(comparable(responses[0]?.body)).toEqual(comparable(responses[1]?.body));
    });

    it('leaves /health reachable without a token', async () => {
      // Proves the global guard was not simply "lock everything": the opt-out
      // has to work, or liveness probes would fail.
      await http().get('/api/health').expect(200);
    });

    it('does not leak the token into the error body or the correlation headers', async () => {
      const token = await mintToken({ expiresIn: '-1h' });

      const response = await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401);

      const serialized = JSON.stringify({ body: response.body, headers: response.headers });
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(token.slice(0, 40));
    });
  });

  // -------------------------------------------------------------------------
  // Forged and misdirected tokens
  // -------------------------------------------------------------------------

  describe('when the token cannot be vouched for', () => {
    it('refuses a token signed by an unrelated key', async () => {
      const forged = await mintToken({ untrustedKey: true });

      await http().get('/api/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('refuses a token issued by someone else', async () => {
      const foreign = await mintToken({ issuer: 'some-other-app' });

      await http().get('/api/auth/me').set('Authorization', `Bearer ${foreign}`).expect(401);
    });

    it('refuses a token minted for a different audience', async () => {
      // A token minted for another service must not be accepted here even though
      // it carries a valid Prometheus signature.
      const foreign = await mintToken({ audience: 'prometheus-billing' });

      await http().get('/api/auth/me').set('Authorization', `Bearer ${foreign}`).expect(401);
    });

    it('refuses an expired token', async () => {
      const stale = await mintToken({ expiresIn: '-1s' });

      await http().get('/api/auth/me').set('Authorization', `Bearer ${stale}`).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // First login
  // -------------------------------------------------------------------------

  describe('on a first login', () => {
    it('creates the user and returns their Prometheus id', async () => {
      const email = emailFor('first-login');
      const { userId } = await firstLogin('google:109876543210', email);

      expect(userId).toEqual(expect.any(String));

      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        include: { authAccounts: true },
      });
      expect(stored.email).toBe(email);
      expect(stored.authAccounts).toHaveLength(1);
      expect(stored.authAccounts[0]).toMatchObject({
        provider: 'google',
        providerAccountId: '109876543210',
      });
    });

    it('records the external identity on the user row', async () => {
      const { userId } = await firstLogin('github:900001', emailFor('github'));

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(stored.authUserId).toBe('github:900001');
    });

    it('does not create a wallet, which belongs to Module 03', async () => {
      const { userId } = await firstLogin('google:wallet-scope', emailFor('no-wallet'));

      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      expect(wallet).toBeNull();
    });

    it('lower-cases the email before storing it', async () => {
      const token = await mintToken({ subject: 'google:case-1', email: 'Mixed.Case@Example.COM' });
      const response = await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
      createdUserIds.push(response.body.id);

      expect(response.body.email).toBe('mixed.case@example.com');
    });

    it('does not create a duplicate user when the same identity logs in twice', async () => {
      const subject = 'google:repeat-login';
      const email = emailFor('repeat');

      const first = await firstLogin(subject, email);
      const second = await firstLogin(subject, email);

      expect(second.userId).toBe(first.userId);

      const matching = await prisma.authAccount.count({
        where: { provider: 'google', providerAccountId: 'repeat-login' },
      });
      expect(matching).toBe(1);
    });

    it('refuses to create a user when the provider shared no email', async () => {
      // A Prometheus user requires an email, and inventing one would produce an
      // account the person can never receive mail about.
      const token = await mintToken({ subject: 'github:no-email', email: '' });

      const response = await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(403);

      expect(response.body).toMatchObject({ code: expect.any(String) });
      const created = await prisma.authAccount.count({ where: { providerAccountId: 'no-email' } });
      expect(created).toBe(0);
    });

    it('refuses a second provider login that reuses an existing email', async () => {
      // The safe-linking case: a GitHub login whose email already has a Google
      // login. Merging on email would let whoever controls GitHub claim the
      // Google-linked Prometheus user.
      const email = emailFor('cross-provider');
      const google = await firstLogin('google:linked-1', email);

      const githubToken = await mintToken({ subject: 'github:linked-1', email });
      const response = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${githubToken}`)
        .expect(409);

      expect(response.body).toMatchObject({ code: expect.any(String) });

      // And critically: no second user, and no account linking happened.
      const users = await prisma.user.count({ where: { email } });
      expect(users).toBe(1);
      const linked = await prisma.authAccount.count({ where: { userId: google.userId } });
      expect(linked).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Returning users and lifecycle state
  // -------------------------------------------------------------------------

  describe('on a returning login', () => {
    it('resolves the same user for either provider', async () => {
      const google = await firstLogin('google:returning-1', emailFor('returning-google'));
      const github = await firstLogin('github:returning-1', emailFor('returning-github'));

      expect(google.userId).not.toBe(github.userId);

      const again = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${google.token}`)
        .expect(200);
      expect(again.body.id).toBe(google.userId);
    });

    it('reports which provider the caller signed in through', async () => {
      const github = await firstLogin('github:provider-label', emailFor('provider-label'));

      const response = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${github.token}`)
        .expect(200);
      expect(response.body.provider).toBe('github');
    });

    it.each([['SUSPENDED'], ['CLOSED']] as const)('refuses a %s user', async (status) => {
      const { token, userId } = await firstLogin(`google:status-${status}`, emailFor(`status-${status}`));
      await prisma.user.update({ where: { id: userId }, data: { status } });

      const response = await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(403);

      expect(response.body).toMatchObject({ code: expect.any(String) });
      // The two states are indistinguishable from outside.
      expect(JSON.stringify(response.body)).not.toContain(status);
    });

    it('answers SUSPENDED and CLOSED with the same code and message', async () => {
      // Two users in two different lifecycle states must be indistinguishable
      // from outside, or the endpoint becomes a way to probe which email
      // addresses exist on the platform and what state they are in.
      const comparable = (body: unknown) => {
        const { code, message } = body as { code: string; message: string };
        return { code, message };
      };

      const suspended = await firstLogin('google:state-s', emailFor('state-s'));
      await prisma.user.update({ where: { id: suspended.userId }, data: { status: 'SUSPENDED' } });
      const closed = await firstLogin('google:state-c', emailFor('state-c'));
      await prisma.user.update({ where: { id: closed.userId }, data: { status: 'CLOSED' } });

      const asSuspended = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${suspended.token}`)
        .expect(403);
      const asClosed = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${closed.token}`)
        .expect(403);

      expect(comparable(asSuspended.body)).toEqual(comparable(asClosed.body));
    });
  });

  // -------------------------------------------------------------------------
  // The identity the caller receives
  // -------------------------------------------------------------------------

  describe('GET /api/auth/me', () => {
    it('returns only the identity, never the credential chain', async () => {
      const { token } = await firstLogin('google:shape-1', emailFor('shape'));

      const response = await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);

      expect(response.body).toEqual({
        id: expect.any(String),
        email: expect.any(String),
        status: 'ACTIVE',
        provider: 'google',
      });
      // authUserId, the provider account id and the token itself are all
      // deliberately absent: a client needs its own user id and nothing else.
      expect(response.body).not.toHaveProperty('authUserId');
      expect(response.body).not.toHaveProperty('providerAccountId');
      expect(response.body).not.toHaveProperty('accessToken');
    });

    it('ignores a caller-supplied user id', async () => {
      const alice = await firstLogin('google:alice', emailFor('alice'));
      const bob = await firstLogin('google:bob', emailFor('bob'));

      // Every input channel a caller might try to smuggle an id through.
      const attempts = await Promise.all([
        http().get('/api/auth/me').query({ userId: bob.userId }).set('Authorization', `Bearer ${alice.token}`),
        http()
          .get('/api/auth/me')
          .query({ id: bob.userId })
          .set('Authorization', `Bearer ${alice.token}`),
        http()
          .post('/api/auth/me')
          .send({ userId: bob.userId })
          .set('Authorization', `Bearer ${alice.token}`),
      ]);

      for (const response of attempts) {
        // POST is not a route on this controller, so it 404s; the GETs must
        // still answer as Alice.
        if (response.status === 200) {
          expect(response.body.id).toBe(alice.userId);
        } else {
          expect(response.status).toBe(404);
        }
      }
    });

    it('never returns bob\'s data to alice, even for a shared provider', async () => {
      const alice = await firstLogin('google:isolation-a', emailFor('isolation-a'));
      const bob = await firstLogin('google:isolation-b', emailFor('isolation-b'));

      const asAlice = await http().get('/api/auth/me').set('Authorization', `Bearer ${alice.token}`).expect(200);
      const asBob = await http().get('/api/auth/me').set('Authorization', `Bearer ${bob.token}`).expect(200);

      expect(asAlice.body.id).toBe(alice.userId);
      expect(asBob.body.id).toBe(bob.userId);
      expect(asAlice.body.email).not.toBe(asBob.body.email);
    });
  });
});