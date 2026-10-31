import { HttpException, HttpStatus } from '@nestjs/common';

import { ERROR_CODES, type ErrorCode } from '../constants/error-codes';

/**
 * Base class for deliberate, expected business failures.
 *
 * Services throw this instead of Nest's `BadRequestException` et al. so the
 * stable {@link ErrorCode} travels with the failure and reaches the client.
 * The global exception filter translates it into the standard error envelope.
 *
 * Anything thrown that is *not* a DomainException is treated as a bug and
 * reported as INTERNAL_ERROR with details suppressed.
 */
export class DomainException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: string[];

  constructor(
    code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    details?: string[],
  ) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }

  static notFound(resource: string, identifier?: string | number): DomainException {
    const message = identifier === undefined ? `${resource} not found` : `${resource} '${identifier}' not found`;
    return new DomainException(ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND);
  }

  static conflict(message: string, details?: string[]): DomainException {
    return new DomainException(ERROR_CODES.CONFLICT, message, HttpStatus.CONFLICT, details);
  }

  static badRequest(message: string, details?: string[]): DomainException {
    return new DomainException(ERROR_CODES.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }

  static forbidden(message = 'You do not have access to this resource'): DomainException {
    return new DomainException(ERROR_CODES.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }

  /**
   * A balance movement that the current balance cannot fund.
   *
   * 409 rather than 400: the request is well-formed, it is the account's state
   * that refuses it, and a retry after a deposit may legitimately succeed.
   */
  static insufficientBalance(assetSymbol?: string): DomainException {
    const subject = assetSymbol ? ` available ${assetSymbol}` : '';
    return new DomainException(
      ERROR_CODES.INSUFFICIENT_BALANCE,
      `Insufficient${subject} balance for this operation.`,
      HttpStatus.CONFLICT,
    );
  }

  /** The wallet exists but is halted, so no balance may move through it. */
  static walletFrozen(): DomainException {
    return new DomainException(
      ERROR_CODES.WALLET_FROZEN,
      'This wallet is frozen and cannot move funds.',
      HttpStatus.CONFLICT,
    );
  }

  /** The asset exists but is retired, so it accepts no new movements. */
  static assetInactive(symbol?: string): DomainException {
    const subject = symbol ? ` '${symbol}'` : '';
    return new DomainException(
      ERROR_CODES.ASSET_INACTIVE,
      `Asset${subject} is not active and cannot be moved.`,
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Eligible simulated LP liquidity cannot cover a BUY order (Module 09).
   *
   * 409 for the same reason as insufficient balance: the request is
   * well-formed, the system's liquidity state refuses it, and a later top-up
   * may legitimately succeed. Whole order rolls back - nothing is partially
   * allocated.
   */
  static insufficientLiquidity(requestedUsdt: string, availableUsdt: string): DomainException {
    return new DomainException(
      ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      `Eligible liquidity (${availableUsdt} USDT) cannot cover this order (${requestedUsdt} USDT). No order was placed.`,
      HttpStatus.CONFLICT,
      [`requested_usdt:${requestedUsdt}`, `available_usdt:${availableUsdt}`],
    );
  }

  /**
   * A discretionary treasury-funded EMBER operation would take the treasury
   * below its approved protected reserve floor (Module 12).
   *
   * 409 for the same reason as insufficient balance: the request is well
   * formed, the treasury's state refuses it, and a later qualifying funding
   * credit may legitimately make it succeed. The burn's whole transaction
   * rolls back - no ledger leg, no burn record, no supply change.
   */
  static treasuryReserveBreach(floor: string, available: string, requested: string): DomainException {
    return new DomainException(
      ERROR_CODES.TREASURY_RESERVE_BREACH,
      `This burn would take the treasury below its protected reserve floor of ${floor} EMBER (requested ${requested} from ${available} available). Funding the treasury raises the balance without lowering the floor; retry after a qualifying deposit.`,
      HttpStatus.CONFLICT,
      [`reserve_floor:${floor}`, `treasury_available:${available}`, `requested:${requested}`],
    );
  }

  /** Commitment endpoints are disabled until approved EMBER slabs are configured. */
  static liquiditySlabsNotConfigured(): DomainException {
    return new DomainException(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'Liquidity commitments are disabled: no EMBER-locking slabs are configured. Ask for approval of the thresholds and retry.',
      HttpStatus.SERVICE_UNAVAILABLE,
      ['liquidity_ember_slabs_not_configured'],
    );
  }
}