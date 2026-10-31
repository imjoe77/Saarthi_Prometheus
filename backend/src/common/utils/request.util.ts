import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

import { DomainException } from '../errors/domain.exception';
import type { ErrorCode } from '../constants/error-codes';

/** Header carrying the correlation id across services and into logs. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Returns the inbound correlation id, or mints one.
 *
 * The id is echoed in the response header so a user-reported error can be
 * traced straight to the corresponding log lines.
 */
export function resolveRequestId(request: Request): string {
  const inbound = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

  if (typeof candidate === 'string' && candidate.trim().length > 0 && candidate.length <= 128) {
    return candidate.trim();
  }

  return randomUUID();
}

/** Pulls a stable {@link ErrorCode} out of anything that carries one. */
export function extractErrorCode(exception: unknown): ErrorCode | null {
  if (exception instanceof DomainException) {
    return exception.code;
  }

  if (typeof exception === 'object' && exception !== null && 'code' in exception) {
    const code = (exception as { code?: unknown }).code;
    if (typeof code === 'string') return code as ErrorCode;
  }

  return null;
}