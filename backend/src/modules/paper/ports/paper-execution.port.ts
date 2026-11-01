import { type Prisma } from '@prisma/client';

/**
 * MODULE 06c - the port by which Module 07 will read committed paper fills.
 *
 * FOLLOWER CONTRACT. The paper ledger produces `FILLED` orders as the only
 * events that represent an execution - rejected requests are recorded but not
 * copied. The port exposes an iterator over fills, ordered by
 * `(filled_at, order_id)`, with a stable cursor, so a follower can resume
 * without replaying a single fill it has already seen. The actual implementation
 * lives inside the paper module (it reads from `paper_orders`) to preserve the
 * one-way dependency: 07 imports 06c's port types but never the tables or the
 * service that writes them.
 */
export interface PaperFill {
  readonly orderId: string;
  readonly strategyId: string;
  readonly symbol: string;
  readonly side: 'LONG' | 'SHORT';
  readonly quantity: Prisma.Decimal;
  readonly fillPrice: Prisma.Decimal;
  readonly filledAt: Date;
}

export const PAPER_EXECUTION_PORT = Symbol('PAPER_EXECUTION_PORT');

/**
 * One follower's position in an expert's fill history.
 *
 * The same shape the copy engine keeps on `strategy_follows`, so a caller can
 * hand its own cursor rows straight over without translating them.
 */
export interface PaperCursor {
  readonly strategyId: string;
  readonly cursorFilledAt: Date | null;
  readonly cursorOrderId: string | null;
}

export interface PaperExecutionPort {
  /**
   * Fetches a page of committed fills after the cursor, ascending by
   * (filledAt, orderId). A null `cursorOrderId` means "from the beginning".
   */
  fillsAfter(
    strategyId: string,
    cursorFilledAt: Date | null,
    cursorOrderId: string | null,
    limit: number,
  ): Promise<readonly PaperFill[]>;

  /**
   * Which of the given cursors have at least one committed fill after them.
   *
   * Batched on purpose: a follower who watches five experts would otherwise
   * pay five round trips to learn the same thing, and the answer is one
   * question about many cursors. The returned set holds the strategy ids
   * that have something waiting - a cursor with nothing after it is simply
   * absent.
   */
  pendingAfter(cursors: readonly PaperCursor[]): Promise<Set<string>>;
}