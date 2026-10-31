import { HttpStatus } from '@nestjs/common';
import { Prisma, StrategyStatus, StrategyVisibility, type Strategy } from '@prisma/client';

import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/errors/domain.exception';
import type { PrismaService } from '../../database/prisma.service';
import { StrategyService } from './strategy.service';

/**
 * MODULE 05 - the strategy registry's own rules.
 *
 * These cover the decisions that are this module's to make and that no amount of
 * HTTP-level testing would pin down precisely: what a create writes, which fields
 * an update touches, what a duplicate name turns into, who may read a row, and
 * that an archived row refuses everything.
 *
 * They run against hand-written fakes because none of this needs PostgreSQL. The
 * properties that genuinely need a real database - that the case-insensitive index
 * exists, that RESTRICT holds, that the CHECK constraints reject a blank name -
 * belong to `test/schema.e2e-spec.ts`, and the properties that need the whole
 * application - the routes, the guard, ownership over HTTP - belong to
 * `test/strategy.e2e-spec.ts`.
 */

const OWNER_ID = 'user-owner-1111';
const OTHER_ID = 'user-other-2222';

interface PrismaMock {
  strategy: {
    create: jest.Mock;
    update: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
}

function makeMocks(): PrismaMock {
  return {
    strategy: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
}

function serviceWith(prisma: PrismaMock): StrategyService {
  return new StrategyService(prisma as unknown as PrismaService);
}

/** A stored row, with only the fields a test actually cares about varying. */
function strategyOf(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: 'strategy-3333',
    ownerId: OWNER_ID,
    name: 'EMBER momentum',
    description: 'Holds EMBER through momentum swings.',
    visibility: StrategyVisibility.PRIVATE,
    status: StrategyStatus.ACTIVE,
    createdAt: new Date('2026-10-05T09:00:00.000Z'),
    updatedAt: new Date('2026-10-05T09:00:00.000Z'),
    ...overrides,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`owner_id`)', {
    code: 'P2002',
    clientVersion: '6.15.0',
  });
}

/**
 * Runs `action` and returns the DomainException it threw.
 *
 * Asserting on the thrown type rather than on a message keeps each test's
 * expectation about behaviour instead of about wording, which is free to change.
 */
async function captureDomainError(run: () => Promise<unknown>): Promise<DomainException> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainException);
    return error as DomainException;
  }

  throw new Error('Expected a DomainException, but the call succeeded.');
}

describe('StrategyService', () => {
  let prisma: PrismaMock;
  let service: StrategyService;

  beforeEach(() => {
    prisma = makeMocks();
    service = serviceWith(prisma);
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  describe('create', () => {
    it('writes the owner from the argument and nothing else', async () => {
      prisma.strategy.create.mockResolvedValue(strategyOf());

      await service.create(OWNER_ID, { name: 'EMBER momentum' });

      expect(prisma.strategy.create).toHaveBeenCalledWith({
        data: {
          ownerId: OWNER_ID,
          name: 'EMBER momentum',
          description: null,
          visibility: StrategyVisibility.PRIVATE,
          status: StrategyStatus.ACTIVE,
        },
      });
    });

    it('is private and active unless the owner says otherwise', async () => {
      prisma.strategy.create.mockResolvedValue(strategyOf());

      await service.create(OWNER_ID, {
        name: 'Published',
        description: 'Out in the open.',
        visibility: StrategyVisibility.PUBLIC,
      });

      expect(prisma.strategy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            visibility: StrategyVisibility.PUBLIC,
            status: StrategyStatus.ACTIVE,
          }),
        }),
      );
    });

    it('trims the name so two spellings cannot look identical on screen', async () => {
      prisma.strategy.create.mockResolvedValue(strategyOf());

      await service.create(OWNER_ID, { name: '  EMBER momentum  ' });

      expect(prisma.strategy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'EMBER momentum' }) }),
      );
    });

    it('stores a whitespace-only description as null rather than as blank text', async () => {
      prisma.strategy.create.mockResolvedValue(strategyOf({ description: null }));

      await service.create(OWNER_ID, { name: 'Blank description', description: '   ' });

      expect(prisma.strategy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ description: null }) }),
      );
    });

    it('never lets a caller choose the status', async () => {
      prisma.strategy.create.mockResolvedValue(strategyOf());

      await service.create(OWNER_ID, { name: 'Born active' });

      expect(prisma.strategy.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: StrategyStatus.ACTIVE }) }),
      );
    });

    it('turns a duplicate name into a conflict that names the rule', async () => {
      prisma.strategy.create.mockRejectedValue(uniqueViolation());

      const error = await captureDomainError(() =>
        service.create(OWNER_ID, { name: 'EMBER momentum' }),
      );

      expect(error.code).toBe(ERROR_CODES.CONFLICT);
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.message).toContain('EMBER momentum');
    });

    it('re-raises any other failure unchanged, because it is a bug', async () => {
      const boom = new Error('connection reset');
      prisma.strategy.create.mockRejectedValue(boom);

      await expect(service.create(OWNER_ID, { name: 'Anything' })).rejects.toBe(boom);
    });
  });

  // ---------------------------------------------------------------------------
  // updateOwned
  // ---------------------------------------------------------------------------

  describe('updateOwned', () => {
    it('refuses a strategy the caller does not own, without reading it as owned', async () => {
      prisma.strategy.findFirst.mockResolvedValue(null);

      const error = await captureDomainError(() =>
        service.updateOwned(OTHER_ID, 'strategy-3333', { name: 'Mine now' }),
      );

      expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(prisma.strategy.update).not.toHaveBeenCalled();
    });

    it('changes only the fields it was given', async () => {
      prisma.strategy.findFirst.mockResolvedValue(strategyOf());
      prisma.strategy.update.mockResolvedValue(strategyOf({ visibility: StrategyVisibility.PUBLIC }));

      await service.updateOwned(OWNER_ID, 'strategy-3333', { visibility: StrategyVisibility.PUBLIC });

      expect(prisma.strategy.update).toHaveBeenCalledWith({
        where: { id: 'strategy-3333' },
        data: { visibility: StrategyVisibility.PUBLIC },
      });
    });

    it('clears the description when an empty one is sent', async () => {
      prisma.strategy.findFirst.mockResolvedValue(strategyOf());
      prisma.strategy.update.mockResolvedValue(strategyOf({ description: null }));

      await service.updateOwned(OWNER_ID, 'strategy-3333', { description: '' });

      expect(prisma.strategy.update).toHaveBeenCalledWith({
        where: { id: 'strategy-3333' },
        data: { description: null },
      });
    });

    it('clears the description when null is sent directly', async () => {
      prisma.strategy.findFirst.mockResolvedValue(strategyOf());
      prisma.strategy.update.mockResolvedValue(strategyOf({ description: null }));

      await service.updateOwned(OWNER_ID, 'strategy-3333', { description: null });

      expect(prisma.strategy.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { description: null } }),
      );
    });

    it('archives on request', async () => {
      prisma.strategy.findFirst.mockResolvedValue(strategyOf());
      prisma.strategy.update.mockResolvedValue(strategyOf({ status: StrategyStatus.ARCHIVED }));

      await service.updateOwned(OWNER_ID, 'strategy-3333', { status: StrategyStatus.ARCHIVED });

      expect(prisma.strategy.update).toHaveBeenCalledWith({
        where: { id: 'strategy-3333' },
        data: { status: StrategyStatus.ARCHIVED },
      });
    });

    it('refuses every change to an archived strategy, including another archive', async () => {
      prisma.strategy.findFirst.mockResolvedValue(
        strategyOf({ status: StrategyStatus.ARCHIVED }),
      );

      const error = await captureDomainError(() =>
        service.updateOwned(OWNER_ID, 'strategy-3333', { name: 'New name' }),
      );

      expect(error.code).toBe(ERROR_CODES.CONFLICT);
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(prisma.strategy.update).not.toHaveBeenCalled();
    });

    it('has no path that turns an archived strategy active again', async () => {
      prisma.strategy.findFirst.mockResolvedValue(
        strategyOf({ status: StrategyStatus.ARCHIVED }),
      );

      await captureDomainError(() =>
        service.updateOwned(OWNER_ID, 'strategy-3333', { status: StrategyStatus.ACTIVE }),
      );

      expect(prisma.strategy.update).not.toHaveBeenCalled();
    });

    it('turns a rename that collides into a conflict', async () => {
      prisma.strategy.findFirst.mockResolvedValue(strategyOf());
      prisma.strategy.update.mockRejectedValue(uniqueViolation());

      const error = await captureDomainError(() =>
        service.updateOwned(OWNER_ID, 'strategy-3333', { name: 'Already taken' }),
      );

      expect(error.code).toBe(ERROR_CODES.CONFLICT);
      expect(error.message).toContain('Already taken');
    });

    it('does not mislabel a unique failure from an update that carried no name', async () => {
      // The index involved is the name index, so a violation raised by a
      // description-only update would be something else entirely and must not be
      // reported as "that name is taken".
      prisma.strategy.findFirst.mockResolvedValue(strategyOf());
      prisma.strategy.update.mockRejectedValue(uniqueViolation());

      await expect(
        service.updateOwned(OWNER_ID, 'strategy-3333', { description: 'New text' }),
      ).rejects.toThrow(uniqueViolation().message);
    });

    it('loads the row it is about to change rather than trusting the id', async () => {
      prisma.strategy.findFirst.mockResolvedValue(strategyOf());
      prisma.strategy.update.mockResolvedValue(strategyOf());

      await service.updateOwned(OWNER_ID, 'strategy-3333', { name: 'Renamed' });

      expect(prisma.strategy.findFirst).toHaveBeenCalledWith({
        where: { id: 'strategy-3333', ownerId: OWNER_ID },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // findVisibleTo
  // ---------------------------------------------------------------------------

  describe('findVisibleTo', () => {
    it('gives the owner their own strategy whatever its state', async () => {
      const archived = strategyOf({ status: StrategyStatus.ARCHIVED });
      prisma.strategy.findUnique.mockResolvedValue(archived);

      await expect(service.findVisibleTo(OWNER_ID, archived.id)).resolves.toBe(archived);
    });

    it('gives another user a public, active strategy', async () => {
      const published = strategyOf({
        ownerId: OTHER_ID,
        visibility: StrategyVisibility.PUBLIC,
      });
      prisma.strategy.findUnique.mockResolvedValue(published);

      await expect(service.findVisibleTo(OWNER_ID, published.id)).resolves.toBe(published);
    });

    it('hides a private strategy from everybody but its owner', async () => {
      prisma.strategy.findUnique.mockResolvedValue(
        strategyOf({ ownerId: OTHER_ID, visibility: StrategyVisibility.PRIVATE }),
      );

      const error = await captureDomainError(() => service.findVisibleTo(OWNER_ID, 'strategy-3333'));

      expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('hides an archived strategy from everybody but its owner', async () => {
      prisma.strategy.findUnique.mockResolvedValue(
        strategyOf({
          ownerId: OTHER_ID,
          visibility: StrategyVisibility.PUBLIC,
          status: StrategyStatus.ARCHIVED,
        }),
      );

      const error = await captureDomainError(() => service.findVisibleTo(OWNER_ID, 'strategy-3333'));

      expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('answers a missing row and a hidden one identically', async () => {
      prisma.strategy.findUnique.mockResolvedValue(null);
      const missing = await captureDomainError(() => service.findVisibleTo(OWNER_ID, 'strategy-3333'));

      prisma.strategy.findUnique.mockResolvedValue(strategyOf({ ownerId: OTHER_ID }));
      const hidden = await captureDomainError(() => service.findVisibleTo(OWNER_ID, 'strategy-3333'));

      // Otherwise "forbidden" versus "not found" would turn the endpoint into an
      // oracle for guessing which strategy ids are real.
      expect(missing.code).toBe(hidden.code);
      expect(missing.getStatus()).toBe(hidden.getStatus());
      expect(missing.message).toBe(hidden.message);
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe('listForOwner', () => {
    beforeEach(() => {
      prisma.strategy.findMany.mockResolvedValue([]);
      prisma.strategy.count.mockResolvedValue(0);
    });

    it('asks for the first page at the default size', async () => {
      await service.listForOwner(OWNER_ID);

      expect(prisma.strategy.findMany).toHaveBeenCalledWith({
        where: { ownerId: OWNER_ID },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      });
    });

    it('turns a page number into an offset', async () => {
      await service.listForOwner(OWNER_ID, { page: 3, limit: 10 });

      expect(prisma.strategy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('reports the page it returned, not the page that was asked for', async () => {
      const result = await service.listForOwner(OWNER_ID, { page: 2, limit: 5 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(5);
    });

    it('clamps a page size that is too large or too small', async () => {
      await service.listForOwner(OWNER_ID, { limit: 5000 });
      expect(prisma.strategy.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 100 }),
      );

      await service.listForOwner(OWNER_ID, { limit: 0 });
      expect(prisma.strategy.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });

    it('treats a nonsense page number as the first page rather than a negative offset', async () => {
      await service.listForOwner(OWNER_ID, { page: -3 });

      expect(prisma.strategy.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0 }));
    });

    it('applies a state filter when one is given', async () => {
      await service.listForOwner(OWNER_ID, { status: StrategyStatus.ARCHIVED });

      expect(prisma.strategy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: OWNER_ID, status: StrategyStatus.ARCHIVED } }),
      );
    });

    it('applies a visibility filter when one is given', async () => {
      await service.listForOwner(OWNER_ID, { visibility: StrategyVisibility.PUBLIC });

      expect(prisma.strategy.count).toHaveBeenCalledWith({
        where: { ownerId: OWNER_ID, visibility: StrategyVisibility.PUBLIC },
      });
    });

    it('includes archived strategies when no filter is given', async () => {
      // The count must be computed over the same set as the page, or a pager
      // would promise more pages than the rows can fill.
      await service.listForOwner(OWNER_ID);

      expect(prisma.strategy.count).toHaveBeenCalledWith({ where: { ownerId: OWNER_ID } });
    });

    it('counts pages from the total, rounding up', async () => {
      prisma.strategy.count.mockResolvedValue(11);

      const result = await service.listForOwner(OWNER_ID, { limit: 5 });

      expect(result.total).toBe(11);
      expect(result.totalPages).toBe(3);
    });

    it('reports no pages at all for an empty catalogue', async () => {
      const result = await service.listForOwner(OWNER_ID);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('counts over the same filters as the page it returns', async () => {
      prisma.strategy.count.mockResolvedValue(1);
      prisma.strategy.findMany.mockResolvedValue([strategyOf()]);

      const result = await service.listForOwner(OWNER_ID, { status: StrategyStatus.ACTIVE });

      const pageArgs = prisma.strategy.findMany.mock.calls[0][0];
      const countArgs = prisma.strategy.count.mock.calls[0][0];
      expect(pageArgs.where).toEqual(countArgs.where);
      expect(result.total).toBe(1);
    });

    it('issues one page read and one count however many strategies exist', async () => {
      await service.listForOwner(OWNER_ID);
      const emptyReads = prisma.strategy.findMany.mock.calls.length + prisma.strategy.count.mock.calls.length;

      prisma.strategy.findMany.mockClear();
      prisma.strategy.count.mockClear();
      prisma.strategy.count.mockResolvedValue(3);
      await service.listForOwner(OWNER_ID);

      expect(prisma.strategy.findMany.mock.calls.length + prisma.strategy.count.mock.calls.length).toBe(
        emptyReads,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listPublic
  // ---------------------------------------------------------------------------

  describe('listPublic', () => {
    beforeEach(() => {
      prisma.strategy.findMany.mockResolvedValue([]);
      prisma.strategy.count.mockResolvedValue(0);
    });

    it('offers public, active strategies and nothing else', async () => {
      await service.listPublic();

      const expected = {
        visibility: StrategyVisibility.PUBLIC,
        status: StrategyStatus.ACTIVE,
      };
      expect(prisma.strategy.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expected }));
      expect(prisma.strategy.count).toHaveBeenCalledWith({ where: expected });
    });

    it('refuses to be widened by a query parameter', async () => {
      await service.listPublic({
        page: 2,
        limit: 5,
        visibility: StrategyVisibility.PRIVATE,
        status: StrategyStatus.ARCHIVED,
      });

      // The caller asked for private, archived rows on page two. It gets public,
      // active rows on page two.
      expect(prisma.strategy.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { visibility: StrategyVisibility.PUBLIC, status: StrategyStatus.ACTIVE },
          skip: 5,
          take: 5,
        }),
      );
    });

    it('paginates the catalogue like any other list', async () => {
      prisma.strategy.count.mockResolvedValue(4);
      prisma.strategy.findMany.mockResolvedValue([strategyOf()]);

      const result = await service.listPublic({ page: 1, limit: 2 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(4);
      expect(result.totalPages).toBe(2);
    });
  });
});
