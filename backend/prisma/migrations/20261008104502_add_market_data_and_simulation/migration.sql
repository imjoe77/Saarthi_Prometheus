-- CreateEnum
CREATE TYPE "FillSide" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "market_candles" (
    "symbol" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "volume" DECIMAL(38,18) NOT NULL,
    "quote_volume" DECIMAL(38,18) NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_file" TEXT NOT NULL,

    CONSTRAINT "market_candles_pkey" PRIMARY KEY ("symbol","day")
);

-- CreateTable
CREATE TABLE "strategy_simulations" (
    "strategy_id" UUID NOT NULL,
    "rule_key" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "initial_cash" DECIMAL(38,18) NOT NULL,
    "fee_rate" DECIMAL(38,18) NOT NULL,
    "day_count" INTEGER NOT NULL,
    "fill_count" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_simulations_pkey" PRIMARY KEY ("strategy_id")
);

-- CreateTable
CREATE TABLE "strategy_fills" (
    "simulation_id" UUID NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "fill_day" DATE NOT NULL,
    "side" "FillSide" NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "gross" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL,
    "cash_after" DECIMAL(38,18) NOT NULL,
    "note" TEXT,

    CONSTRAINT "strategy_fills_pkey" PRIMARY KEY ("simulation_id","sequence_no")
);

-- CreateTable
CREATE TABLE "strategy_daily_balance" (
    "simulation_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "cash" DECIMAL(38,18) NOT NULL,
    "position_qty" DECIMAL(38,18) NOT NULL,
    "position_value" DECIMAL(38,18) NOT NULL,
    "value" DECIMAL(38,18) NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_daily_balance_pkey" PRIMARY KEY ("simulation_id","day")
);

-- CreateIndex
CREATE INDEX "market_candles_day_idx" ON "market_candles"("day");

-- CreateIndex
CREATE INDEX "strategy_simulations_rule_key_idx" ON "strategy_simulations"("rule_key");

-- CreateIndex
CREATE INDEX "strategy_fills_simulation_id_fill_day_idx" ON "strategy_fills"("simulation_id", "fill_day");

-- AddForeignKey
ALTER TABLE "strategy_simulations" ADD CONSTRAINT "strategy_simulations_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_fills" ADD CONSTRAINT "strategy_fills_simulation_id_fkey" FOREIGN KEY ("simulation_id") REFERENCES "strategy_simulations"("strategy_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_daily_balance" ADD CONSTRAINT "strategy_daily_balance_simulation_id_fkey" FOREIGN KEY ("simulation_id") REFERENCES "strategy_simulations"("strategy_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity constraints Prisma cannot express. Module 01 established the
-- pattern of hand-written CHECKs in migration SQL because a column Prisma
-- believes is valid must still be invalid when written by raw SQL - and this
-- module is written by raw SQL far more often than by the client, because the
-- importer is the only writer.

-- A bar whose high does not reach its own open or close describes a range the
-- market never traded, and one whose low sits above either would make the
-- low-to-high span meaningless. Together with high >= low these four rules are
-- what "this is a real OHLC bar" means.
ALTER TABLE "market_candles"
    ADD CONSTRAINT "market_candles_ohlc_sane"
    CHECK ("high" >= "low"
        AND "high" >= "open" AND "high" >= "close"
        AND "low" <= "open" AND "low" <= "close");

-- Prices are positive quantities. A zero or negative price is a missing value
-- wearing a number's clothes, and it would poison every return computed from it.
ALTER TABLE "market_candles"
    ADD CONSTRAINT "market_candles_prices_positive"
    CHECK ("open" > 0 AND "high" > 0 AND "low" > 0 AND "close" > 0);

-- Volume cannot be negative. Zero is allowed: an asset can genuinely not trade
-- on a day, and hiding that would invent activity that did not happen.
ALTER TABLE "market_candles"
    ADD CONSTRAINT "market_candles_volume_non_negative"
    CHECK ("volume" >= 0 AND "quote_volume" >= 0);

-- A simulation window that ends before it starts would produce a curve over
-- no days at all and then claim an observation count of zero was measured.
ALTER TABLE "strategy_simulations"
    ADD CONSTRAINT "strategy_simulations_window_ordered"
    CHECK ("window_start" <= "window_end");

ALTER TABLE "strategy_simulations"
    ADD CONSTRAINT "strategy_simulations_counts_non_negative"
    CHECK ("day_count" >= 0 AND "fill_count" >= 0);

-- Paper cash and an assumed fee rate are both strictly positive starting
-- conditions: a simulation that began with nothing could never open a
-- position, and a negative fee would be paying the exchange to trade.
ALTER TABLE "strategy_simulations"
    ADD CONSTRAINT "strategy_simulations_start_positive"
    CHECK ("initial_cash" > 0 AND "fee_rate" > 0);

ALTER TABLE "strategy_simulations"
    ADD CONSTRAINT "strategy_simulations_labels_non_blank"
    CHECK (length(btrim("rule_key")) > 0 AND length(btrim("symbol")) > 0);

-- A fill exists to move a position, so it has size and a price. A zero fee is
-- impossible under the documented 0.1% assumption and would silently change
-- what the curve is worth; cash after a fill is never negative because the
-- engine sizes a buy so that gross plus fee fits inside the cash it has.
ALTER TABLE "strategy_fills"
    ADD CONSTRAINT "strategy_fills_amounts_sane"
    CHECK ("quantity" > 0 AND "price" > 0 AND "fee" >= 0 AND "cash_after" >= 0);

ALTER TABLE "strategy_fills"
    ADD CONSTRAINT "strategy_fills_sequence_positive"
    CHECK ("sequence_no" >= 1);

-- The derived-state rules. Cash and units held are never negative, and the
-- total is their sum: it must be at least zero, or the row claims the
-- strategy owed somebody something. Module 06 additionally refuses a series
-- point that is not strictly positive, so a zero here would surface as
-- INVALID_SERIES rather than as a plausible-looking reading.
ALTER TABLE "strategy_daily_balance"
    ADD CONSTRAINT "strategy_daily_balance_non_negative"
    CHECK ("cash" >= 0 AND "position_qty" >= 0 AND "position_value" >= 0 AND "value" >= 0);

-- The headline number is the sum it claims to be. Stated in SQL so a manual
-- UPDATE cannot leave cash and value disagreeing.
ALTER TABLE "strategy_daily_balance"
    ADD CONSTRAINT "strategy_daily_balance_value_is_sum"
    CHECK ("value" = round("cash" + "position_value", 18));
