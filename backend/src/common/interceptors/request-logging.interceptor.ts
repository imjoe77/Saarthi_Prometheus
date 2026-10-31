import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { performance } from 'node:perf_hooks';
import { Observable, tap } from 'rxjs';

import { REQUEST_ID_HEADER, resolveRequestId } from '../utils/request.util';

/**
 * Emits one structured log line per completed HTTP request and stamps the
 * correlation id onto the response so the client can quote it in a bug report.
 *
 * Duration is measured around the handler only, and logging happens on
 * completion (including failures) so an aborted request still leaves a trace.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId = resolveRequestId(request);
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const method = request.method ?? 'UNKNOWN';
    const path = (request.originalUrl ?? request.url ?? 'unknown').split('?')[0] ?? 'unknown';
    const startedAt = performance.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.write('log', this.line(method, path, response.statusCode, startedAt, requestId));
        },
        error: (exception: unknown) => {
          const status =
            exception instanceof HttpException ? exception.getStatus() : response.statusCode ?? 500;
          this.write(
            status >= 500 ? 'error' : 'warn',
            this.line(method, path, status, startedAt, requestId),
          );
        },
      }),
    );
  }

  private line(
    method: string,
    path: string,
    status: number,
    startedAt: number,
    requestId: string,
  ): string {
    return `${method} ${path} ${status} ${(performance.now() - startedAt).toFixed(1)}ms requestId=${requestId}`;
  }

  private write(level: 'log' | 'warn' | 'error', message: string): void {
    this.logger[level](message);
  }
}