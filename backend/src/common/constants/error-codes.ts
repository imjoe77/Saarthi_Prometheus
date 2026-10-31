/**
 * Canonical machine-readable error codes.
 *
 * Services throw domain errors carrying one of these codes. Clients (and the
 * frontend) can branch on `code` and never have to parse an English message.
 *
 * Values are stable and part of the public API contract - do not rename or
 * renumber. Add new codes instead.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
  TREASURY_RESERVE_BREACH: 'TREASURY_RESERVE_BREACH',
  WALLET_FROZEN: 'WALLET_FROZEN',
  ASSET_INACTIVE: 'ASSET_INACTIVE',
  PRICING_UNAVAILABLE: 'PRICING_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];