-- LONG / SHORT positions.
--
-- The enum values are RENAMED, not dropped and recreated, so every committed
-- paper order and copy event keeps its row: a BUY was a LONG and a SELL was a
-- SHORT, and the ledger that read them still reads them.
ALTER TYPE "PaperOrderSide" RENAME VALUE 'BUY' TO 'LONG';
ALTER TYPE "PaperOrderSide" RENAME VALUE 'SELL' TO 'SHORT';

-- Which way an open position points. A position may now be short, so the
-- direction is stored next to the (always positive) magnitude rather than
-- being implied by it.
CREATE TYPE "PositionDirection" AS ENUM ('LONG', 'SHORT');

-- Existing rows are long by construction: the ledgers they came from were
-- long-only, and a short is a position this schema could not previously hold.
ALTER TABLE "paper_positions" ADD COLUMN "direction" "PositionDirection" NOT NULL DEFAULT 'LONG';
ALTER TABLE "copy_positions" ADD COLUMN "direction" "PositionDirection" NOT NULL DEFAULT 'LONG';

-- Per-fill realised P&L. A fill that opens or adds to a position realises
-- nothing; a fill that closes against one realises exactly this much.
ALTER TABLE "paper_orders" ADD COLUMN "realized_pnl" DECIMAL(38,18);
ALTER TABLE "copy_events" ADD COLUMN "realized_pnl" DECIMAL(38,18) NOT NULL DEFAULT 0;

-- A new refusal reason: the trader's real USDT wallet cannot cover the order.
ALTER TYPE "PaperRejectReason" ADD VALUE 'INSUFFICIENT_WALLET_BALANCE';
ALTER TYPE "CopyRejectReason" ADD VALUE 'INSUFFICIENT_WALLET_BALANCE';
