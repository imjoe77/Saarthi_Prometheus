import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { StrategyStatus, StrategyVisibility } from '@prisma/client';
import request from 'supertest';

import { createApp } from '../src/bootstrap';
import type { DomainException } from '../src/common/errors/domain.exception';
import { PrismaService } from '../src/database/prisma.service';
import { mintToken } from './token-minting';

/**
 * The shape of a strategy as it comes back over HTTP, and of a failure as the
 * exception filter renders it.
 *
 * Both are declared rather than left as `Record<string, unknown>` so that a field
 * rename in the DTO surfaces here as a type error instead of as an assertion that
 * quietly stops comparing.
 */
interface StrategyPayload {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  requestId: string;
}

/**
 * MODULE 05 - the strategy registry over HTTP.
 *
 * Boots the real application against the real database, because the properties
 * this module most needs proving are database properties: that one owner cannot
 * hold two strategies whose names differ only by case, that P2002 arrives as a
 * 409 with our own error code rather than as a 500, and that ownership holds
 * against a real token rather than a mocked one.
 *
 * Two boundaries are asserted as carefully as the happy paths, because they are
 * the ones a later module could quietly erode:
 *
 *  - NO OWNER IN ANY REQUEST. No body field, path parameter or query parameter
 *    can name an owner. A client that sends one is rejected by the validation pipe
 *    rather than being quietly ignored, so a typo cannot look like it worked.
 *  - NO PERFORMANCE FIGURES. Every response is searched for the field names this
 *    project has refused to invent, so a future edit that adds one fails here
 *    instead of reaching a screen.
 *
 * Isolation: users are created through the real auth path with a UUID in the
 * email, and purged in `afterAll`. Strategies are deleted before their users
 * because `strategies.owner_id` is ON DELETE RESTRICT, which this suite relies on
 * and also verifies.
 */
describe('Strategy (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      // Restrict means the user cannot go first. This ordering is the constraint
      // being obeyed, not tidiness.
      await prisma.strategy.deleteMany({ where: { ownerId: { in: createdUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Creates a Prometheus user through the real auth path and returns a token. */
  async function createUser(label: string): Promise<{ token: string; userId: string; email: string }> {
    const email = `${label}-${randomUUID()}@strategy.test`;
    const token = await mintToken({ subject: `google:${label}-${randomUUID()}`, email });

    const response = await http().get('/api/auth/me').set(bearer(token)).expect(200);
    createdUserIds.push(response.body.id);

    return { token, userId: response.body.id, email };
  }

  async function createStrategy(
    user: { token: string },
    body: Record<string, unknown> = {},
  ): Promise<StrategyPayload> {
    const response = await http()
      .post('/api/strategies')
      .set(bearer(user.token))
      .send({ name: `Strategy ${randomUUID().slice(0, 8)}`, ...body })
      .expect(201);

    return response.body as StrategyPayload;
  }

  /** Asserts a failure carries our stable code, and returns the body. */
  function expectDomainError(
    response: request.Response,
    code: DomainException['code'],
    status: HttpStatus,
  ): ErrorPayload {
    const body = response.body as ErrorPayload;
    expect(body.code).toBe(code);
    expect(response.status).toBe(status);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');

    return body;
  }

  // ---------------------------------------------------------------------------

  describe('route surface', () => {
    it('refuses every strategy route without a token', async () => {
      const user = await createUser('surface');

      await http().post('/api/strategies').send({ name: 'Anonymous' }).expect(401);
      await http().get('/api/strategies').expect(401);
      await http().get('/api/strategies/me').expect(401);
      await http().get(`/api/strategies/${user.userId}`).expect(401);
      await http().patch(`/api/strategies/${randomUUID()}`).send({ name: 'Anonymous' }).expect(401);
    });

    it('has no route that names another owner', async () => {
      const owner = await createUser('named');
      const victim = await createUser('victim');

      // Rejected, not ignored: a client that thinks it is filing a strategy for
      // somebody else must be told no rather than being quietly given its own.
      await http()
        .post('/api/strategies')
        .set(bearer(owner.token))
        .send({ name: 'Not mine', ownerId: victim.userId })
        .expect(400);

      await http()
        .patch(`/api/strategies/${randomUUID()}`)
        .set(bearer(owner.token))
        .send({ name: 'Not mine', owner: victim.userId })
        .expect(400);
    });

    it('exposes no delete route, because retirement replaces it', async () => {
      const user = await createUser('nodelete');
      const strategy = await createStrategy(user);

      await http().delete(`/api/strategies/${strategy.id}`).set(bearer(user.token)).expect(404);

      // And the row is genuinely still there, so 404 means "no such route" rather
      // than "route exists but refused".
      const survivor = await prisma.strategy.findUnique({ where: { id: strategy.id } });
      expect(survivor).not.toBeNull();
      expect(survivor?.status).toBe(StrategyStatus.ACTIVE);
    });

    it('creates a strategy for a user who has no wallet', async () => {
      // Independence, stated as a test: a strategy has no financial position, so
      // requiring a wallet would be an invented coupling.
      const user = await createUser('nowallet');

      await http().get('/api/wallets/me').set(bearer(user.token)).expect(404);

      const strategy = await createStrategy(user, { name: 'No wallet needed' });

      expect(strategy.status).toBe(StrategyStatus.ACTIVE);
    });
  });

  // ---------------------------------------------------------------------------

  describe('creating', () => {
    it('creates a private, active strategy with no description', async () => {
      const user = await createUser('create');

      const { body } = await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: '  EMBER momentum  ' })
        .expect(201);

      expect(body).toEqual({
        id: expect.any(String),
        name: 'EMBER momentum',
        description: null,
        visibility: StrategyVisibility.PRIVATE,
        status: StrategyStatus.ACTIVE,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('publishes one immediately when asked', async () => {
      const user = await createUser('publish');

      const { body } = await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: 'Published', description: 'Out in the open.', visibility: 'PUBLIC' })
        .expect(201);

      expect(body.visibility).toBe(StrategyVisibility.PUBLIC);
      expect(body.description).toBe('Out in the open.');
    });

    it('keeps the owner out of the response, because the owner is the caller', async () => {
      const user = await createUser('nowner');

      const { body } = await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: 'Anonymous to itself' })
        .expect(201);

      expect(body).not.toHaveProperty('ownerId');
      expect(JSON.stringify(body)).not.toContain(user.email);
    });

    it('refuses a second strategy with the same name', async () => {
      const user = await createUser('duplicate');

      await http().post('/api/strategies').set(bearer(user.token)).send({ name: 'Twice' }).expect(201);

      const response = await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: 'Twice' })
        .expect(409);

      expectDomainError(response, 'CONFLICT', HttpStatus.CONFLICT);
    });

    it('refuses a second strategy whose name differs only by case', async () => {
      // This is the case-insensitive rule, and it can only be proven by the real
      // functional index - a service-side string comparison could be bypassed by
      // any other writer.
      const user = await createUser('case');

      await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: 'EMBER Momentum' })
        .expect(201);

      const response = await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: 'ember momentum' })
        .expect(409);

      expectDomainError(response, 'CONFLICT', HttpStatus.CONFLICT);
    });

    it('refuses a second strategy whose name differs only by surrounding space', async () => {
      const user = await createUser('space');

      await http().post('/api/strategies').set(bearer(user.token)).send({ name: 'Spaced' }).expect(201);

      await http()
        .post('/api/strategies')
        .set(bearer(user.token))
        .send({ name: '  Spaced  ' })
        .expect(409);
    });

    it('lets two different owners hold the same name', async () => {
      const first = await createUser('shared-first');
      const second = await createUser('shared-second');

      await http().post('/api/strategies').set(bearer(first.token)).send({ name: 'Same name' }).expect(201);
      await http()
        .post('/api/strategies')
        .set(bearer(second.token))
        .send({ name: 'Same name' })
        .expect(201);
    });

    it.each([
      ['a missing name', {}, 400],
      ['a blank name', { name: '   ' }, 400],
      ['an over-long name', { name: 'x'.repeat(81) }, 400],
      ['an over-long description', { name: 'Fine', description: 'x'.repeat(1001) }, 400],
      ['an unknown status', { name: 'Fine', status: 'ARCHIVED' }, 400],
      ['an unknown visibility', { name: 'Fine', visibility: 'UNLISTED' }, 400],
      ['an unknown field', { name: 'Fine', riskLevel: 'HIGH' }, 400],
    ])('rejects %s', async (_label, payload, expected) => {
      const user = await createUser(`invalid-${expected}`);

      await http().post('/api/strategies').set(bearer(user.token)).send(payload).expect(expected);
    });
  });

  // ---------------------------------------------------------------------------

  describe('listing the caller’s own strategies', () => {
    it('lists only that caller’s strategies, newest first', async () => {
      const user = await createUser('mine');
      const other = await createUser('mine-other');

      const first = await createStrategy(user, { name: 'First' });
      const second = await createStrategy(user, { name: 'Second' });
      await createStrategy(other, { name: 'Somebody else’' });

      const { body } = await http().get('/api/strategies/me').set(bearer(user.token)).expect(200);

      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(20);
      expect(body.totalPages).toBe(1);
      expect(body.items.map((item: { id: string }) => item.id)).toEqual([second.id, first.id]);
    });

    it('includes archived strategies until they are filtered out', async () => {
      const user = await createUser('archived-list');
      const strategy = await createStrategy(user, { name: 'To archive' });

      await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const all = await http().get('/api/strategies/me').set(bearer(user.token)).expect(200);
      expect(all.body.total).toBe(1);
      expect(all.body.items[0].status).toBe(StrategyStatus.ARCHIVED);

      const active = await http()
        .get('/api/strategies/me?status=ACTIVE')
        .set(bearer(user.token))
        .expect(200);
      expect(active.body.total).toBe(0);
      expect(active.body.totalPages).toBe(0);
    });

    it('reports an empty catalogue as zero rather than as an error', async () => {
      const user = await createUser('empty');

      const { body } = await http().get('/api/strategies/me').set(bearer(user.token)).expect(200);

      expect(body).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    it('pages by offset and reports the totals behind the pager', async () => {
      const user = await createUser('paging');

      for (const name of ['One', 'Two', 'Three']) {
        await createStrategy(user, { name: `${name} ${user.userId.slice(0, 4)}` });
      }

      const first = await http()
        .get('/api/strategies/me?limit=2&page=1')
        .set(bearer(user.token))
        .expect(200);
      const second = await http()
        .get('/api/strategies/me?limit=2&page=2')
        .set(bearer(user.token))
        .expect(200);

      expect(first.body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(first.body.items).toHaveLength(2);
      expect(second.body).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(second.body.items).toHaveLength(1);

      const firstIds = first.body.items.map((item: { id: string }) => item.id);
      expect(second.body.items.map((item: { id: string }) => item.id)).not.toEqual(firstIds);
    });

    it('filters by visibility', async () => {
      const user = await createUser('filter-visibility');

      await createStrategy(user, { name: 'Kept private' });
      await createStrategy(user, { name: 'Published', visibility: 'PUBLIC' });

      const { body } = await http()
        .get('/api/strategies/me?visibility=PUBLIC')
        .set(bearer(user.token))
        .expect(200);

      expect(body.total).toBe(1);
      expect(body.items[0].visibility).toBe(StrategyVisibility.PUBLIC);
    });

    it.each([
      ['page=0', 400],
      ['page=-1', 400],
      ['page=abc', 400],
      ['limit=0', 400],
      ['limit=101', 400],
      ['status=PUBLISHED', 400],
    ])('rejects %s', async (query, expected) => {
      const user = await createUser('badquery');

      await http().get(`/api/strategies/me?${query}`).set(bearer(user.token)).expect(expected);
    });
  });

  // ---------------------------------------------------------------------------

  describe('discovery', () => {
    it('offers public, active strategies from every account', async () => {
      const author = await createUser('discover-author');
      const reader = await createUser('discover-reader');

      const published = await createStrategy(author, {
        name: 'Discoverable',
        description: 'Worth a look.',
        visibility: 'PUBLIC',
      });
      const withdrawn = await createStrategy(author, { name: 'Private one' });
      const retired = await createStrategy(author, { name: 'Retired one', visibility: 'PUBLIC' });
      await http()
        .patch(`/api/strategies/${retired.id}`)
        .set(bearer(author.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const { body } = await http().get('/api/strategies').set(bearer(reader.token)).expect(200);
      const ids = body.items.map((item: { id: string }) => item.id);

      expect(ids).toContain(published.id);
      expect(ids).not.toContain(withdrawn.id);
      expect(ids).not.toContain(retired.id);
    });

    it('hides every owner identity from the catalogue', async () => {
      const author = await createUser('identity-author');
      const reader = await createUser('identity-reader');

      await createStrategy(author, { name: 'Anonymous in public', visibility: 'PUBLIC' });

      const { body } = await http().get('/api/strategies').set(bearer(reader.token)).expect(200);

      const serialised = JSON.stringify(body);
      expect(body.items[0]).not.toHaveProperty('ownerId');
      expect(body.items[0]).not.toHaveProperty('owner');
      expect(body.items[0]).not.toHaveProperty('email');
      expect(serialised).not.toContain(author.email);
      expect(serialised).not.toContain(author.userId);
    });

    it('ignores query parameters that would widen it', async () => {
      const author = await createUser('widen-author');
      const reader = await createUser('widen-reader');

      const privateStrategy = await createStrategy(author, { name: 'Still private' });
      const archived = await createStrategy(author, { name: 'Still archived', visibility: 'PUBLIC' });
      await http()
        .patch(`/api/strategies/${archived.id}`)
        .set(bearer(author.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const { body } = await http()
        .get('/api/strategies?status=ARCHIVED&visibility=PRIVATE')
        .set(bearer(reader.token))
        .expect(200);

      const ids = body.items.map((item: { id: string }) => item.id);
      expect(ids).not.toContain(privateStrategy.id);
      expect(ids).not.toContain(archived.id);
    });

    it('pages like any other list, and the totals describe the whole catalogue', async () => {
      const author = await createUser('discover-paging');
      const reader = await createUser('discover-paging-reader');

      const created: string[] = [];
      for (const name of ['Alpha', 'Bravo', 'Charlie']) {
        const strategy = await createStrategy(author, {
          name: `${name} ${author.userId.slice(0, 4)}`,
          visibility: 'PUBLIC',
        });
        created.push(strategy.id);
      }

      const first = await http()
        .get('/api/strategies?limit=2&page=1')
        .set(bearer(reader.token))
        .expect(200);
      const second = await http()
        .get('/api/strategies?limit=2&page=2')
        .set(bearer(reader.token))
        .expect(200);

      expect(first.body.page).toBe(1);
      expect(first.body.limit).toBe(2);
      expect(first.body.items).toHaveLength(2);

      // The catalogue is shared, so the total is asserted against itself rather
      // than against a fixed number: the pager must describe the catalogue it is
      // actually paging, or a client would render a page that does not exist.
      expect(first.body.totalPages).toBe(Math.ceil(first.body.total / 2));
      expect(second.body.total).toBe(first.body.total);

      const seen = new Set([
        ...first.body.items.map((item: { id: string }) => item.id),
        ...second.body.items.map((item: { id: string }) => item.id),
      ]);
      expect([...created].filter((id) => !seen.has(id))).toEqual([]);
      expect([...seen].filter((id) => first.body.items.some((i: { id: string }) => i.id === id) && second.body.items.some((i: { id: string }) => i.id === id))).toEqual([]);
    });

    it('answers with a well-formed empty page when the catalogue has nothing in it', async () => {
      // The catalogue is global, so it cannot be emptied from inside this test.
      // What is checked here is the envelope a fresh reader receives: shaped,
      // consistent, and never an error - the same shape the owner listing returns
      // when it genuinely has no rows.
      const reader = await createUser('discover-empty');

      const { body } = await http().get('/api/strategies?limit=5&page=1').set(bearer(reader.token)).expect(200);

      expect(body.page).toBe(1);
      expect(body.limit).toBe(5);
      expect(typeof body.total).toBe('number');
      expect(body.items.length).toBeLessThanOrEqual(5);
      expect(body.totalPages).toBe(body.total === 0 ? 0 : Math.ceil(body.total / 5));
    });
  });

  // ---------------------------------------------------------------------------

  describe('reading one strategy', () => {
    it('gives the owner the full record', async () => {
      const user = await createUser('detail-owner');
      const strategy = await createStrategy(user, { name: 'Mine', description: 'Explained.' });

      const { body } = await http()
        .get(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .expect(200);

      expect(body).toEqual({
        id: strategy.id,
        name: 'Mine',
        description: 'Explained.',
        visibility: StrategyVisibility.PRIVATE,
        status: StrategyStatus.ACTIVE,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('shows the owner an archived strategy they retired', async () => {
      const user = await createUser('detail-archived');
      const strategy = await createStrategy(user, { name: 'Retired' });

      await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);

      const { body } = await http()
        .get(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .expect(200);

      expect(body.status).toBe(StrategyStatus.ARCHIVED);
    });

    it('gives another user a public, active strategy without any owner identity', async () => {
      const author = await createUser('detail-author');
      const reader = await createUser('detail-reader');
      const strategy = await createStrategy(author, {
        name: 'Public one',
        description: 'Explained.',
        visibility: 'PUBLIC',
      });

      const { body } = await http()
        .get(`/api/strategies/${strategy.id}`)
        .set(bearer(reader.token))
        .expect(200);

      expect(body).toEqual({
        id: strategy.id,
        name: 'Public one',
        description: 'Explained.',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(JSON.stringify(body)).not.toContain(author.userId);
      expect(JSON.stringify(body)).not.toContain(author.email);
    });

    it.each([
      ['private', StrategyVisibility.PRIVATE, StrategyStatus.ACTIVE],
      ['public but archived', StrategyVisibility.PUBLIC, StrategyStatus.ARCHIVED],
      ['private and archived', StrategyVisibility.PRIVATE, StrategyStatus.ARCHIVED],
    ])(
      'answers 404 to another user for a strategy that is %s',
      async (_label, visibility, status) => {
        const author = await createUser(`hidden-${visibility}-${status}`);
        const reader = await createUser(`hidden-reader-${visibility}-${status}`);
        const strategy = await createStrategy(author, { name: 'Hidden', visibility });

        if (status === StrategyStatus.ARCHIVED) {
          await http()
            .patch(`/api/strategies/${strategy.id}`)
            .set(bearer(author.token))
            .send({ status: 'ARCHIVED' })
            .expect(200);
        }

        const response = await http()
          .get(`/api/strategies/${strategy.id}`)
          .set(bearer(reader.token))
          .expect(404);

        expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);
      },
    );

    it('answers 404 for an id that does not exist', async () => {
      const user = await createUser('detail-missing');

      const response = await http()
        .get(`/api/strategies/${randomUUID()}`)
        .set(bearer(user.token))
        .expect(404);

      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);
    });

    it('answers 400 for an id that is not a uuid', async () => {
      const user = await createUser('detail-malformed');

      // Rejected before it reaches the database, rather than being handed to
      // Prisma to fail on.
      await http().get('/api/strategies/not-a-uuid').set(bearer(user.token)).expect(400);
    });

    it('never mistakes the literal /me for a strategy id', async () => {
      const user = await createUser('detail-me');

      const { body } = await http().get('/api/strategies/me').set(bearer(user.token)).expect(200);

      expect(body).toHaveProperty('items');
    });
  });

  // ---------------------------------------------------------------------------

  describe('changing one strategy', () => {
    it('renames, re-describes and republishes', async () => {
      const user = await createUser('update');
      const strategy = await createStrategy(user, { name: 'Before' });

      const renamed = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ name: 'After' })
        .expect(200);
      expect(renamed.body).toMatchObject({ name: 'After', description: null });

      const described = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ description: 'Now with words.' })
        .expect(200);
      expect(described.body).toMatchObject({ name: 'After', description: 'Now with words.' });

      const published = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ visibility: 'PUBLIC' })
        .expect(200);
      expect(published.body).toMatchObject({ visibility: StrategyVisibility.PUBLIC, status: StrategyStatus.ACTIVE });
    });

    it('clears a description when one is sent empty', async () => {
      const user = await createUser('update-clear');
      const strategy = await createStrategy(user, { name: 'Verbose', description: 'Words.' });

      const { body } = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ description: '' })
        .expect(200);

      expect(body.description).toBeNull();
    });

    it('retires a strategy, and never brings it back', async () => {
      const user = await createUser('update-archive');
      const strategy = await createStrategy(user, { name: 'Retiring' });

      const archived = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ status: 'ARCHIVED' })
        .expect(200);
      expect(archived.body.status).toBe(StrategyStatus.ARCHIVED);

      const refused = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ name: 'Changed anyway' })
        .expect(409);
      expectDomainError(refused, 'CONFLICT', HttpStatus.CONFLICT);

      // ACTIVE is not a legal target: the one-way decision is enforced by the DTO,
      // not merely left to the service.
      const reactivated = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ status: 'ACTIVE' })
        .expect(400);
      expect(reactivated.body.code).toBe('VALIDATION_FAILED');

      const stored = await prisma.strategy.findUniqueOrThrow({ where: { id: strategy.id } });
      expect(stored.name).toBe('Retiring');
      expect(stored.status).toBe(StrategyStatus.ARCHIVED);
    });

    it('refuses a rename onto a name the caller already uses', async () => {
      const user = await createUser('update-conflict');
      await createStrategy(user, { name: 'Taken' });
      const other = await createStrategy(user, { name: 'Free' });

      const response = await http()
        .patch(`/api/strategies/${other.id}`)
        .set(bearer(user.token))
        .send({ name: 'taken' })
        .expect(409);

      expectDomainError(response, 'CONFLICT', HttpStatus.CONFLICT);
    });

    it('accepts a rename to the name the strategy already has', async () => {
      const user = await createUser('update-self');
      const strategy = await createStrategy(user, { name: 'Unchanged' });

      await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send({ name: 'Unchanged' })
        .expect(200);
    });

    it('will not let one user touch another user’s strategy', async () => {
      const owner = await createUser('update-owner');
      const attacker = await createUser('update-attacker');
      const strategy = await createStrategy(owner, { name: 'Hands off', description: 'Mine.' });

      const response = await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(attacker.token))
        .send({ name: 'Taken over' })
        .expect(404);

      // 404 rather than 403: a 403 would confirm the id is real.
      expectDomainError(response, 'NOT_FOUND', HttpStatus.NOT_FOUND);

      const stored = await prisma.strategy.findUniqueOrThrow({ where: { id: strategy.id } });
      expect(stored.name).toBe('Hands off');
      expect(stored.ownerId).toBe(owner.userId);
    });

    it('answers 404 when archiving a strategy that does not exist', async () => {
      const user = await createUser('update-missing');

      await http()
        .patch(`/api/strategies/${randomUUID()}`)
        .set(bearer(user.token))
        .send({ status: 'ARCHIVED' })
        .expect(404);
    });

    it.each([
      ['a blank name', { name: '   ' }, 400],
      ['an unknown status', { status: 'RETIRED' }, 400],
      ['an unknown field', { riskScore: 3 }, 400],
      ['a performance field', { roi: 12.5 }, 400],
    ])('rejects %s', async (_label, payload, expected) => {
      const user = await createUser(`update-invalid-${expected}`);
      const strategy = await createStrategy(user);

      await http()
        .patch(`/api/strategies/${strategy.id}`)
        .set(bearer(user.token))
        .send(payload)
        .expect(expected);
    });
  });

  // ---------------------------------------------------------------------------

  describe('what this module refuses to store or report', () => {
    const FORBIDDEN_FIELDS = [
      'roi',
      'apy',
      'annualReturn',
      'sharpe',
      'sharpeRatio',
      'sortino',
      'winRate',
      'profitFactor',
      'drawdown',
      'maxDrawdown',
      'pnl',
      'realizedPnl',
      'unrealizedPnl',
      'profit',
      'aum',
      'assetsUnderManagement',
      'followers',
      'followerCount',
      'riskLevel',
      'riskScore',
      'performance',
      'performanceSnapshot',
      'category',
      'tags',
      'assets',
      'entryRules',
      'exitRules',
      'leverage',
    ];

    it('adds none of them to the table', async () => {
      // Read from the live catalog rather than the ORM model, because the claim is
      // about what is physically stored.
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'strategies'
      `;
      const columns = rows.map((row) => row.column_name);

      for (const forbidden of FORBIDDEN_FIELDS) {
        expect(columns).not.toContain(forbidden);
      }
      expect(columns.sort()).toEqual([
        'created_at',
        'description',
        'id',
        'name',
        'owner_id',
        'status',
        'updated_at',
        'visibility',
      ]);
    });

    it('sends none of them in any response', async () => {
      const owner = await createUser('honest-owner');
      const reader = await createUser('honest-reader');
      const strategy = await createStrategy(owner, {
        name: 'Honest about ignorance',
        description: 'No numbers to report yet.',
        visibility: 'PUBLIC',
      });

      const bodies = [
        (await http().get('/api/strategies/me').set(bearer(owner.token))).body,
        (await http().get('/api/strategies').set(bearer(reader.token))).body,
        (await http().get(`/api/strategies/${strategy.id}`).set(bearer(owner.token))).body,
        (await http().get(`/api/strategies/${strategy.id}`).set(bearer(reader.token))).body,
      ];

      for (const body of bodies) {
        const serialised = JSON.stringify(body);
        for (const forbidden of FORBIDDEN_FIELDS) {
          expect(serialised).not.toContain(`"${forbidden}"`);
        }
        expect(serialised).not.toContain('NaN');
        expect(serialised).not.toContain('Infinity');
      }
    });
  });

  // ---------------------------------------------------------------------------

  describe('ownership at the database level', () => {
    it('refuses to delete a user who owns a strategy', async () => {
      // The RESTRICT that Modules 06 and 07 depend on: a deletion must not be
      // able to take follow history with it.
      const user = await createUser('restrict-owner');
      await createStrategy(user);

      await expect(prisma.user.delete({ where: { id: user.userId } })).rejects.toBeDefined();

      // Still there, and the strategy is intact.
      const survivor = await prisma.user.findUnique({ where: { id: user.userId } });
      expect(survivor).not.toBeNull();
      expect(await prisma.strategy.count({ where: { ownerId: user.userId } })).toBe(1);
    });
  });
});
