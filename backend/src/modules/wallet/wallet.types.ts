import type { Asset, Transaction, WalletBalance } from '@prisma/client';

/**
 * MODULE 03 — shapes used across the wallet module.
 *
 * A balance and a ledger row are always rendered together with their asset,
 * because neither is meaningful without its display precision. Declaring the
 * intersection once keeps the service, the DTOs and the tests agreeing on the
 * same shape.
 */
export type BalanceWithAsset = WalletBalance & { asset: Asset };

export type TransactionWithAsset = Transaction & { asset: Asset };
