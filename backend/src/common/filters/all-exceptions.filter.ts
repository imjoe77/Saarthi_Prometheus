import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';

import { ERROR_CODES, type ErrorCode } from '../constants/error-codes';
import type { ApiErrorBody } from '../interfaces/api-error-body.interface';
import { REQUEST_ID_HEADER, extractErrorCode, resolveRequestId } from '../utils/request.util';

/** Lowest HTTP status that indicates a server-side fault rather than a client mistake. */
const SERVER_ERROR_MIN = 500;

/**
 * Status-to-code mapping.
 *
 * A lookup table rather than a `switch` on `HttpStatus` members: `getStatus()`
 * returns a plain `number`, and mixing that with the enum type in comparisons
 * defeats the enum's type checking.
 */
const STATUS_TO_ERROR_CODE: Readonly<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ERROR_CODES.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.NOT_FOUND,
  [HttpStatus.CONFLICT]: ERROR_CODES.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODES.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ERROR_CODES.SERVICE_UNAVAILABLE,
};

/**
 * Single funnel for every error leaving the API.
 *
 * Guarantees three things:
 *  1. A stable JSON envelope (see {@link ApiErrorBody}) regardless of origin.
 *  2. Internal details never leak to clients for unexpected failures - the
 *     client gets a generic message while the full error is logged.
 *  3. Every response carries a correlation id matching the logged one.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Parameters<typeof resolveRequestId>[0]>();
    const response = http.getResponse<Response>();

    const requestId = resolveRequestId(request);
    const path: string = request.originalUrl ?? request.url ?? 'unknown';
    const method: string = request.method ?? 'UNKNOWN';

    const { status, code, message, details, logError } = this.describe(exception);

    const body: ApiErrorBody = {
      code,
      message,
      timestamp: new Date().toISOString(),
      path,
      requestId,
      ...(details.length > 0 ? { details } : {}),
    };

    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.status(status).json(body);

    const context = `${method} ${path} requestId=${requestId}`;
    if (logError) {
      // Unexpected: stack trace matters, so log the full exception.
      this.logger.error(`${context} ${message}`, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(`${context} ${code} ${message}`);
    }
  }

  private describe(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details: string[];
    logError: boolean;
  } {
    // Deliberate, well-understood failures: safe to describe precisely.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const extracted = extractErrorCode(exception);

      if (typeof payload === 'string') {
        return {
          status,
          code: extracted ?? this.codeForStatus(status),
          message: payload,
          details: [],
          logError: false,
        };
      }

      const record = payload as Record<string, unknown>;
      const rawDetails = record['details'];

      return {
        status,
        code: extracted ?? this.codeForStatus(status),
        message: this.messageFromPayload(record, status),
        details: Array.isArray(rawDetails) ? rawDetails.map(String) : [],
        logError: status >= SERVER_ERROR_MIN,
      };
    }

    // Anything else is a bug. Do not leak the message or stack to the client.
    this.logger.debug(`Unhandled exception type: ${exception === null ? 'null' : typeof exception}`);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'An unexpected error occurred. Please try again.',
      details: [],
      logError: true,
    };
  }

  private messageFromPayload(payload: Record<string, unknown>, status: number): string {
    const candidates = [payload['message'], payload['error']];
    const found = candidates.find((value): value is string | string[] => typeof value === 'string' || Array.isArray(value));

    if (Array.isArray(found)) return found.join('; ');
    if (typeof found === 'string') return found;

    return this.defaultMessageForStatus(status);
  }

  private codeForStatus(status: number): ErrorCode {
    const mapped = STATUS_TO_ERROR_CODE[status];
    if (mapped) return mapped;
    return status >= SERVER_ERROR_MIN ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_FAILED;
  }

  private defaultMessageForStatus(status: number): string {
    const message = HttpStatus[status];
    return typeof message === 'string' ? message.replace(/(\d{3})\.$/, '$1').replace(/\.$/, '') : 'Request failed';
  }
}