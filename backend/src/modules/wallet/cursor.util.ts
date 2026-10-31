import { DomainException } from '../../common/errors/domain.exception';

/**
 * MODULE 03 — opaque keyset cursors for the transaction history.
 *
 * A cursor encodes the sort key of the last row a client saw, `(createdAt, id)`.
 * The next page asks for rows strictly older than that pair, so paging is stable
 * even while new transactions are written at the front. The payload is base64url
 * JSON and versioned; the client treats it as opaque and passes it back as-is.
 */

const CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  createdAt: string;
  id: string;
}

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

function invalidCursor(): DomainException {
  return DomainException.badRequest('Invalid cursor.');
}

export function encodeCursor(createdAt: Date, id: string): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    createdAt: createdAt.toISOString(),
    id,
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
    typeof payload.createdAt !== 'string' ||
    typeof payload.id !== 'string' ||
    payload.id.length === 0
  ) {
    throw invalidCursor();
  }

  const createdAt = new Date(payload.createdAt);

  if (Number.isNaN(createdAt.getTime())) {
    throw invalidCursor();
  }

  return { createdAt, id: payload.id };
}
