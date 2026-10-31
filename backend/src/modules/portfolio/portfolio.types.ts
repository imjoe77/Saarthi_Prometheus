import {
  type Asset,
  type AssetKind,
  type Prisma,
  type TransactionType,
  type WalletStatus,
} from '@prisma/client';

/**
 * MODULE 04 — the derived portfolio read model.
 *
 * Nothing here is stored. Every field is computed from `wallet_balances` and
 * `transactions` at request time, which is what keeps `WalletBalance` the single
 * source of truth for what a user holds.
 *
 * WHAT IS DELIBERATELY ABSENT, and why:
 *
 *  - No valuation. `Asset` carries a symbol, a name, a kind, a display precision
 *    and an active flag. It carries no price, and the repository contains no
 *    price source, market feed or exchange rate. So there is no honest way to
 *    state what one USDT or one EMBER is worth, and no field for it exists here
 *    — not even a null placeholder, because a permanently null field teaches
 *    clients to expect data that never arrives.
 *
 *  - No P&L. The ledger records *stock movements*, not flows of value: a
 *    DEPOSIT of 1000 USDT has no purchase price attached, so it has no cost
 *    basis and no gain or loss. Realised P&L additionally needs positions and
 *    acquisition costs, and unrealized P&L needs a current price. None of those
 *    exist yet, so no P&L figure is derivable from this schema today.
 *
 *  - No allocation percentage across assets. A percentage needs a shared
 *    denominator, and the denominator would be a sum across incompatible units
 *    (INR + USDT + EMBER). `composition.byKind` counts assets by *category*,
 *    which is a different and honest statement.
 */

/** One asset's holding, with every figure derived from that one balance row. */
export interface PortfolioHolding {
  readonly asset: Asset;
  /** Spendable now, exactly as stored. */
  readonly available: Prisma.Decimal;
  /** Reserved against a pending obligation, exactly as stored. */
  readonly locked: Prisma.Decimal;
  /** `available + locked`. Derived here, never stored, never sent to a client to cache. */
  readonly total: Prisma.Decimal;
  /** True when `total > 0`. A drained balance row is still a holding; it is just empty. */
  readonly isFunded: boolean;
  /**
   * `locked / total` as a number between 0 and 1, or null when the total is zero.
   *
   * A plain `number` is correct here and only here: the ratio is dimensionless,
   * so there is no decimal-arithmetic hazard, and a `number` keeps the client
   * from having to parse it back. Every *monetary* value in this module stays a
   * string.
   */
  readonly lockedShare: number | null;
}

/** Categorical composition of the holdings. Deliberately not a value split. */
export interface PortfolioComposition {
  /** Balance rows associated with this wallet, funded or not. */
  readonly assetCount: number;
  /** Of those, how many hold a non-zero balance. */
  readonly fundedAssetCount: number;
  /** Holding counts per asset category. All three keys are always present. */
  readonly byKind: Readonly<Record<AssetKind, number>>;
}

/** Movement counts derived from the ledger. Counts, never money. */
export interface PortfolioActivity {
  readonly totalMovements: number;
  readonly movementsLast30Days: number;
  /** Counts keyed by `TransactionType`; every member is present, zero included. */
  readonly byType: Readonly<Record<TransactionType, number>>;
  readonly firstMovementAt: string;
  readonly lastMovementAt: string;
}

/** The wallet a portfolio describes, reduced to what the read model needs. */
export interface PortfolioWallet {
  readonly id: string;
  readonly status: WalletStatus;
  readonly createdAt: Date;
}

/**
 * One coherent snapshot of a user's financial position.
 *
 * `wallet: null` with empty holdings and no activity is a valid state, not a
 * failure: an authenticated user who has not created a wallet yet has an empty
 * portfolio, and saying so is more useful than a 404.
 */
export interface PortfolioSnapshot {
  readonly wallet: PortfolioWallet | null;
  readonly holdings: readonly PortfolioHolding[];
  readonly composition: PortfolioComposition;
  readonly activity: PortfolioActivity | null;
  readonly generatedAt: Date;
}

/** Zeroed counters, so a response shape never depends on which rows exist. */
export function emptyTypeCounts(): Record<TransactionType, number> {
  return {
    DEPOSIT: 0,
    WITHDRAWAL: 0,
    TRANSFER_IN: 0,
    TRANSFER_OUT: 0,
    LOCK: 0,
    UNLOCK: 0,
    ADJUSTMENT: 0,
    BURN: 0,
  };
}

export function emptyComposition(): PortfolioComposition {
  return {
    assetCount: 0,
    fundedAssetCount: 0,
    byKind: { FIAT: 0, STABLECOIN: 0, TOKEN: 0 },
  };
}