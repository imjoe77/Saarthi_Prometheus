import { HttpException, HttpStatus } from '@nestjs/common';

import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from './domain.exception';

describe('DomainException', () => {
  it('carries a stable code, message and HTTP status', () => {
    const exception = new DomainException(
      ERROR_CODES.INSUFFICIENT_BALANCE,
      'Not enough USDT available.',
      HttpStatus.CONFLICT,
    );

    expect(exception.code).toBe('INSUFFICIENT_BALANCE');
    expect(exception.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(exception.message).toContain('Not enough USDT available.');
  });

  it('defaults to 400 for a validation failure', () => {
    expect(DomainException.badRequest('Invalid amount.').getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('reports 404 without an identifier', () => {
    const exception = DomainException.notFound('Strategy');

    expect(exception.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(exception.message).toBe('Strategy not found');
  });

  it('includes the identifier in the message when provided', () => {
    expect(DomainException.notFound('Strategy', 'abc-123').message).toBe("Strategy 'abc-123' not found");
  });

  it('exposes 409 for conflicts', () => {
    const exception = DomainException.conflict('Copy already active.');

    expect(exception.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(exception.code).toBe('CONFLICT');
  });

  it('exposes 403 for authorisation failures', () => {
    expect(DomainException.forbidden().getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('passes field-level details through for UI display', () => {
    const exception = DomainException.badRequest('Validation failed.', ['amount must be positive']);

    expect(exception.details).toEqual(['amount must be positive']);
  });

  it('is catchable as an HttpException so the global filter can map it', () => {
    expect(DomainException.badRequest('x')).toBeInstanceOf(HttpException);
  });
});