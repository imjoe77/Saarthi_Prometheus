import { Injectable } from '@nestjs/common';
import { Prisma, StrategyStatus, StrategyVisibility, type Strategy } from '@prisma/client';

import { DomainException } from '../../common/errors/domain.exception';
import { PrismaService } from '../../database/prisma.service';

/**
 * MODULE 05 - the strategy registry.
 *
 * A strategy in Prometheus is a named, owned record: who created it, what they
 * call it, what they say about it, whether others may see it, and whether it has
 * been retired. That is the entire domain. This service owns the whole of it and
 * nothing beyond it.
 *
 * WHAT IT DELIBERATELY DOES NOT KNOW:
 *
 *  - How a strategy performs. No price source and no performance history exist,
 *    so there is nothing here to compute a return, a risk score or a drawdown
 *    from, and inventing one is the failure mode this module is built to avoid.
 *  - How a strategy trades. Assets, sizing and entry/exit rules belong to Copy
 *    Trading (Module 07) and the execution engine. This service stores no
 *    execution parameter, so it cannot contradict them later.
 *  - Who follows a strategy. That is a relationship Modules 06/07 will attach to
 *    this table; the FK they will point at is here, the join is not.
 *
 * INDEPENDENCE: this service touches `PrismaService` and nothing else. It does
 * not import `WalletModule` or `PortfolioModule`, and it does not need them - a
 * strategy has no financial position, so there is nothing to read from a wallet
 * and nothing to write to one. A user may hold no wallet at all and still own a
 * strategy, which is the clearest proof the two domains are not coupled.
 *
 * OWNERSHIP IS NEVER AN INPUT. Every method that touches a specific strategy
 * takes the caller's id and derives the row from it, so there is no code path in
 * which a request can name an owner. A strategy that is not the caller's reads as
 * absent rather than forbidden (404, not 403): answering "forbidden" would
 * confirm the id exists, which turns the catalogue into an enumeration oracle.
 *
 * ARCHIVING IS ONE-WAY. There is no unarchive method, because the row is
 * `ON DELETE RESTRICT` and later modules will attach follow and copy history to
 * it. A status that could go back to ACTIVE would let an owner re-activate a
 * strategy whose followers were never told it had been retired.
 */

export interface CreateStrategyInput {
  name: string;
  description?: string | null;
  visibility?: StrategyVisibility;
}

export interface UpdateStrategyInput {
  name?: string;
  description?: string | null;
  visibility?: StrategyVisibility;
  status?: StrategyStatus;
}

export interface ListStrategiesOptions {
  page?: number;
  limit?: number;
  status?: StrategyStatus;
  visibility?: StrategyVisibility;
}

export interface StrategyPage {
  items: Strategy[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Default and maximum page sizes. Applied here as well as in the DTO, because a
 *  future internal caller constructs this object without going through HTTP. */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class StrategyService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Creates one strategy for the caller, ACTIVE and PRIVATE unless the owner
   * published it immediately.
   *
   * A duplicate name arrives as Prisma's P2002 from the functional unique index
   * on `(owner_id, lower(name))`, which is the only place that rule is enforced.
   * It is translated here rather than in the global exception filter so the
   * client gets a 409 with a message about *this* rule instead of a generic
   * internal error for a request that was perfectly well formed.
   */
  async create(ownerId: string, input: CreateStrategyInput): Promise<Strategy> {
    try {
      return await this.prisma.strategy.create({
        data: {
          ownerId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          visibility: input.visibility ?? StrategyVisibility.PRIVATE,
          status: StrategyStatus.ACTIVE,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        throw DomainException.conflict(
          `You already own a strategy called '${input.name.trim()}'. Strategy names are unique per account, ignoring case.`,
        );
      }

      throw error;
    }
  }

  /**
   * Applies an owner's changes to one of their strategies.
   *
   * Refuses an archived strategy outright. The row is kept for reference and for
   * the follow/copy history that will attach to it, but it is frozen: an archived
   * strategy that could still be edited would leave its name and description
   * describing a behaviour nobody can act on any more.
   *
   * A name change can violate the same unique index as creation, so the same P2002
   * translation applies. Renaming a strategy to its own current spelling is a
   * no-op update rather than an error, since the row already holds that name.
   */
  async updateOwned(ownerId: string, id: string, input: UpdateStrategyInput): Promise<Strategy> {
    const existing = await this.findOwned(ownerId, id);

    // Re-checked here, not only in the DTO. The DTO is the HTTP boundary; this is
    // the invariant, and a future internal caller must not be able to pass
    // ACTIVE and unarchive a row through a path that never saw the pipe.
    if (input.status !== undefined && input.status !== StrategyStatus.ARCHIVED) {
      throw DomainException.badRequest(
        `status may only be set to ARCHIVED; '${input.status}' is not a transition this service performs.`,
      );
    }

    if (existing.status === StrategyStatus.ARCHIVED) {
      throw DomainException.conflict(
        'This strategy is archived and can no longer be changed. Archiving is permanent.',
      );
    }

    // Only the fields the client actually sent. An absent key means "leave it
    // alone"; `description: ''` means "clear it", which is why this is built as
    // an explicit object rather than by spreading the input.
    const data: Prisma.StrategyUpdateInput = {};

    if (input.name !== undefined) data.name = input.name.trim();
    // `null` clears the description outright; an empty string is the HTTP spelling
    // of the same request, so both end up as null rather than as "".
    if (input.description !== undefined) {
      data.description = input.description === null ? null : input.description.trim() || null;
    }
    if (input.visibility !== undefined) {
      data.visibility = input.visibility;
    }
    if (input.status !== undefined) data.status = input.status;

    try {
      return await this.prisma.strategy.update({ where: { id: existing.id }, data });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error) && input.name !== undefined) {
        throw DomainException.conflict(
          `You already own a strategy called '${input.name.trim()}'. Strategy names are unique per account, ignoring case.`,
        );
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * One page of the caller's own strategies, newest first.
   *
   * Archived strategies are included unless the client filters for them out: a
   * retired strategy still belongs to its owner and should stay visible to them,
   * it simply stops being offered to anyone else.
   */
  async listForOwner(ownerId: string, options: ListStrategiesOptions = {}): Promise<StrategyPage> {
    const where: Prisma.StrategyWhereInput = { ownerId };

    if (options.status !== undefined) where.status = options.status;
    if (options.visibility !== undefined) where.visibility = options.visibility;

    return this.page(where, options);
  }

  /**
   * The public catalogue: PUBLIC and ACTIVE, newest first.
   *
   * Both conditions are fixed here rather than accepted from the caller. A
   * discovery endpoint that let a client ask for private or archived rows would be
   * a way to read other people's strategies, so the set is a property of the route
   * and not of the query string.
   */
  async listPublic(options: ListStrategiesOptions = {}): Promise<StrategyPage> {
    return this.page(
      { visibility: StrategyVisibility.PUBLIC, status: StrategyStatus.ACTIVE },
      options,
    );
  }

  /**
   * One strategy, if the caller is allowed to see it.
   *
   * The owner sees their own strategy whatever its visibility and whatever its
   * state - an archived one included, because that is the only way they can see
   * what they retired. Everybody else sees it only while it is PUBLIC and ACTIVE.
   *
   * Everything else is 404. Distinguishing "not yours" from "does not exist"
   * would let a caller with a list of ids confirm which are real.
   */
  async findVisibleTo(viewerId: string, id: string): Promise<Strategy> {
    const strategy = await this.prisma.strategy.findUnique({ where: { id } });

    if (!strategy) {
      throw DomainException.notFound('Strategy', id);
    }

    if (strategy.ownerId === viewerId) {
      return strategy;
    }

    if (
      strategy.visibility !== StrategyVisibility.PUBLIC ||
      strategy.status !== StrategyStatus.ACTIVE
    ) {
      throw DomainException.notFound('Strategy', id);
    }

    return strategy;
  }

  /**
   * One strategy that the caller must own, for a write. Not part of the HTTP
   * surface: it is the check that stands in front of `updateOwned`.
   */
  async findOwned(ownerId: string, id: string): Promise<Strategy> {
    const strategy = await this.prisma.strategy.findFirst({ where: { id, ownerId } });

    if (!strategy) {
      throw DomainException.notFound('Strategy', id);
    }

    return strategy;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Runs one offset page plus its total.
   *
   * `id` breaks ties in the ordering so that rows created in the same
   * millisecond - which PostgreSQL's timestamptz(3) resolution makes possible -
   * cannot swap places between two requests and make the same offset return a
   * different row twice.
   *
   * `totalPages` is 0 for an empty set: there are no pages to show, so a client
   * testing `totalPages > 0` renders no pager rather than an empty one.
   */
  private async page(where: Prisma.StrategyWhereInput, options: ListStrategiesOptions): Promise<StrategyPage> {
    const limit = this.clamp(options.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const pageNumber = Math.max(1, Math.trunc(options.page ?? 1));

    const [items, total] = await Promise.all([
      this.prisma.strategy.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (pageNumber - 1) * limit,
        take: limit,
      }),
      this.prisma.strategy.count({ where }),
    ]);

    return {
      items,
      page: pageNumber,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
  }

  /**
   * Prisma's unique-constraint violation, whatever created the constraint.
   *
   * This module's index is created by hand rather than by Prisma's schema
   * language, and the mapping from PostgreSQL's `unique_violation` to `P2002`
   * happens in the driver, so the code is the same either way. Checked rather
   * than assumed: anything that is not this exact error is a bug and must be left
   * alone to surface as a 500.
   */
  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
