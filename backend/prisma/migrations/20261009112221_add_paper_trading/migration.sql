-- CreateEnum
CREATE TYPE "PaperOrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PaperOrderStatus" AS ENUM ('FILLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaperRejectReason" AS ENUM ('MARKET_DATA_UNAVAILABLE', 'STALE_MARKET_DATA', 'MARKET_CLOSED', 'INSUFFICIENT_PAPER_CASH', 'INSUFFICIENT_POSITION');

-- CreateTable
CREATE TABLE "paper_accounts" (
    "strategy_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "cash" DECIMAL(38,18) NOT NULL DEFAULT 100000,
    "realized_pnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "paper_accounts_pkey" PRIMARY KEY ("strategy_id")
);

-- CreateTable
CREATE TABLE "paper_orders" (
    "order_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "PaperOrderSide" NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "status" "PaperOrderStatus" NOT NULL DEFAULT 'FILLED',
    "reject_reason" "PaperRejectReason",
    "fill_price" DECIMAL(38,18),
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filled_at" TIMESTAMPTZ(3),
    "client_request_id" TEXT NOT NULL,
    "paperAccountStrategyId" UUID,

    CONSTRAINT "paper_orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "paper_positions" (
    "strategy_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "average_entry_price" DECIMAL(38,18) NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "paperAccountStrategyId" UUID,

    CONSTRAINT "paper_positions_pkey" PRIMARY KEY ("strategy_id","symbol")
);

-- CreateIndex
CREATE INDEX "paper_orders_strategy_id_placed_at_idx" ON "paper_orders"("strategy_id", "placed_at" DESC);

-- CreateIndex
CREATE INDEX "paper_orders_strategy_id_status_filled_at_idx" ON "paper_orders"("strategy_id", "status", "filled_at");

-- CreateIndex
CREATE UNIQUE INDEX "paper_orders_strategy_id_client_request_id_key" ON "paper_orders"("strategy_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_paperAccountStrategyId_fkey" FOREIGN KEY ("paperAccountStrategyId") REFERENCES "paper_accounts"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_paperAccountStrategyId_fkey" FOREIGN KEY ("paperAccountStrategyId") REFERENCES "paper_accounts"("strategy_id") ON DELETE SET NULL ON UPDATE CASCADE;
