-- CreateEnum
CREATE TYPE "UsdtOrderSide" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "usdt_orders" (
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "side" "UsdtOrderSide" NOT NULL,
    "usdt_amount" DECIMAL(38,18) NOT NULL,
    "inr_amount" DECIMAL(38,18) NOT NULL,
    "prometheus_price" DECIMAL(38,18) NOT NULL,
    "reference_price" DECIMAL(38,18) NOT NULL,
    "savings" DECIMAL(38,18) NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usdt_orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateIndex
CREATE INDEX "usdt_orders_user_id_placed_at_idx" ON "usdt_orders"("user_id", "placed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "usdt_orders_user_id_client_request_id_key" ON "usdt_orders"("user_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "usdt_orders" ADD CONSTRAINT "usdt_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
