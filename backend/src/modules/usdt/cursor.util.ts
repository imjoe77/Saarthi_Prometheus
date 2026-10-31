import { DomainException } from '../../common/errors/domain.exception';

/**
 * MODULE 08 — opaque keyset cursors for the order history.
 *
 * Same shape as Module 03's transaction cursor, keyed on this table's sort
 * pair: `(placedAt, orderId)`. The next page asks for rows strictly older than
 * that pair, so paging is stable while new orders are written at the front. The
 * payload is base64url JSON and versioned; the client treats it as opaque.
 */

const CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  placedAt: string;
  orderId: string;
}

export interface DecodedCursor {
  placedAt: Date;
  orderId: string;
}

function invalidCursor(): DomainException {
  return DomainException.badRequest('Invalid cursor.');
}

export function encodeCursor(placedAt: Date, orderId: string): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    placedAt: placedAt.toISOString(),
    orderId,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor. Anything malformed - bad base64, bad JSON, a
 * missing or wrongly-typed field, an unparseable date - becomes the same 400,
 * so a broken client cannot tell which part it got wrong.
 */
export function decodeCursor(cursor: string): DecodedCursor {
  let payload: CursorPayload;

  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    payload = JSON.parse(json) as CursorPayload;
  } catch {
    throw invalidCursor();
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    payload.v !== CURSOR_VERSION ||
    typeof payload.placedAt !== 'string' ||
    typeof payload.orderId !== 'string' ||
    payload.orderId.length === 0
  ) {
    throw invalidCursor();
  }

  const placedAt = new Date(payload.placedAt);

  if (Number.isNaN(placedAt.getTime())) {
    throw invalidCursor();
  }

  return { placedAt, orderId: payload.orderId };
}
