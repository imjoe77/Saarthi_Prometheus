-- The net book can hold a short, so "you hold none of this" is no longer a
-- refusal: a LONG or a SHORT both work from a flat book. The two enums lose
-- the member that said otherwise. No row referenced it - it was never produced
-- by a rule that could fire under the old long-only book either.
--
-- PostgreSQL cannot drop an enum member in place, so the type is rebuilt: the
-- column is widened to TEXT, the type is replaced, and the column is narrowed
-- back. The cast back is what would fail if a row still carried the removed
-- value, so the migration is its own proof that no row did.
ALTER TABLE "paper_orders" ALTER COLUMN "reject_reason" TYPE TEXT USING ("reject_reason"::TEXT);
DROP TYPE "PaperRejectReason";
CREATE TYPE "PaperRejectReason" AS ENUM (
  'MARKET_DATA_UNAVAILABLE',
  'STALE_MARKET_DATA',
  'MARKET_CLOSED',
  'INSUFFICIENT_PAPER_CASH',
  'INSUFFICIENT_WALLET_BALANCE'
);
ALTER TABLE "paper_orders" ALTER COLUMN "reject_reason" TYPE "PaperRejectReason" USING ("reject_reason"::TEXT::"PaperRejectReason");

ALTER TABLE "copy_events" ALTER COLUMN "reject_reason" TYPE TEXT USING ("reject_reason"::TEXT);
DROP TYPE "CopyRejectReason";
CREATE TYPE "CopyRejectReason" AS ENUM (
  'FOLLOW_NOT_ACTIVE',
  'STRATEGY_ARCHIVED',
  'STRATEGY_NOT_ELIGIBLE',
  'ALLOCATION_ROUNDED_TO_ZERO',
  'INSUFFICIENT_COPY_CASH',
  'PRICE_UNAVAILABLE',
  'INSUFFICIENT_WALLET_BALANCE'
);
ALTER TABLE "copy_events" ALTER COLUMN "reject_reason" TYPE "CopyRejectReason" USING ("reject_reason"::TEXT::"CopyRejectReason");

-- Realised P&L is "nothing realised" or a number, and null is how this schema
-- says "nothing" everywhere else - a null price on a refused fill, a null
-- account before the first copy.
ALTER TABLE "copy_events" ALTER COLUMN "realized_pnl" DROP NOT NULL;
