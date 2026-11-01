-- MODULE 08 x MODULE 11 integration: the exchange revenue outbox.
--
-- One row per settled USDT order the tokenomics pipeline was asked to consider.
-- order_id is unique, so an order can never fund two allocations however often
-- settlement is replayed, retried or raced. Purely additive: no existing table,
-- column or constraint is touched.

-- CreateEnum
CREATE TYPE "ExchangeRevenueStatus" AS ENUM ('INELIGIBLE', 'PENDING', 'PROCESSING', 'COMPLETED', 'BLOCKED', 'FAILED');

-- CreateTable
CREATE TABLE "exchange_revenue_events" (
    "event_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "order_side" "UsdtOrderSide" NOT NULL,
    "order_usdt_amount" DECIMAL(38,18) NOT NULL,
    "customer_inr" DECIMAL(38,18) NOT NULL,
    "lp_inr_settled" DECIMAL(38,18) NOT NULL,
    "retained_inr" DECIMAL(38,18) NOT NULL,
    "revenue_mode" TEXT NOT NULL,
    "revenue_bps" INTEGER NOT NULL,
    "revenue_inr" DECIMAL(38,18) NOT NULL,
    "ember_price" DECIMAL(38,18) NOT NULL,
    "direct_burn_pct" INTEGER NOT NULL,
    "buyback_pct" INTEGER NOT NULL,
    "status" "ExchangeRevenueStatus" NOT NULL DEFAULT 'PENDING',
    "reason_code" TEXT NOT NULL,
    "detail" TEXT,
    "allocation_id" UUID,
    "buyback_id" UUID,
    "direct_burn_id" UUID,
    "buyback_burn_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(3),
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exchange_revenue_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_revenue_events_order_id_key" ON "exchange_revenue_events"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_revenue_events_allocation_id_key" ON "exchange_revenue_events"("allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_revenue_events_buyback_id_key" ON "exchange_revenue_events"("buyback_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_revenue_events_direct_burn_id_key" ON "exchange_revenue_events"("direct_burn_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_revenue_events_buyback_burn_id_key" ON "exchange_revenue_events"("buyback_burn_id");

-- CreateIndex
CREATE INDEX "exchange_revenue_events_status_next_attempt_idx" ON "exchange_revenue_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "exchange_revenue_events_status_detected_idx" ON "exchange_revenue_events"("status", "detected_at" DESC);

-- AddForeignKey
ALTER TABLE "exchange_revenue_events" ADD CONSTRAINT "exchange_revenue_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "usdt_orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_revenue_events" ADD CONSTRAINT "exchange_revenue_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_revenue_events" ADD CONSTRAINT "exchange_revenue_events_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "token_allocations"("allocation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_revenue_events" ADD CONSTRAINT "exchange_revenue_events_buyback_id_fkey" FOREIGN KEY ("buyback_id") REFERENCES "token_buybacks"("buyback_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_revenue_events" ADD CONSTRAINT "exchange_revenue_events_direct_burn_id_fkey" FOREIGN KEY ("direct_burn_id") REFERENCES "token_burns"("burn_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_revenue_events" ADD CONSTRAINT "exchange_revenue_events_buyback_burn_id_fkey" FOREIGN KEY ("buyback_burn_id") REFERENCES "token_burns"("burn_id") ON DELETE RESTRICT ON UPDATE CASCADE;

