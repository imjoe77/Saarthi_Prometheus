-- CreateEnum
CREATE TYPE "TokenBurnSource" AS ENUM ('DIRECT', 'BUYBACK');

-- CreateEnum
CREATE TYPE "TokenBuybackStatus" AS ENUM ('SIMULATED', 'RECORDED_SIMULATED_EXECUTION');

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'BURN';

-- CreateTable
CREATE TABLE "token_allocations" (
    "allocation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reference_amount" DECIMAL(38,18) NOT NULL,
    "ember_price" DECIMAL(38,18) NOT NULL,
    "direct_burn_pct" INTEGER NOT NULL,
    "buyback_pct" INTEGER NOT NULL,
    "direct_burn_inr" DECIMAL(38,18) NOT NULL,
    "buyback_inr" DECIMAL(38,18) NOT NULL,
    "direct_burn_ember" DECIMAL(38,18) NOT NULL,
    "buyback_ember" DECIMAL(38,18) NOT NULL,
    "client_request_id" UUID NOT NULL,
    "allocated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_allocations_pkey" PRIMARY KEY ("allocation_id")
);

-- CreateTable
CREATE TABLE "token_buybacks" (
    "buyback_id" UUID NOT NULL,
    "allocation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "TokenBuybackStatus" NOT NULL DEFAULT 'SIMULATED',
    "client_request_id" UUID NOT NULL,
    "simulated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_price" DECIMAL(38,18),
    "executed_ember" DECIMAL(38,18),
    "executed_at" TIMESTAMPTZ(3),

    CONSTRAINT "token_buybacks_pkey" PRIMARY KEY ("buyback_id")
);

-- CreateTable
CREATE TABLE "token_burns" (
    "burn_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" "TokenBurnSource" NOT NULL,
    "buyback_id" UUID,
    "amount" DECIMAL(38,18) NOT NULL,
    "client_request_id" UUID NOT NULL,
    "burned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_burns_pkey" PRIMARY KEY ("burn_id")
);

-- CreateIndex
CREATE INDEX "token_allocations_user_allocated_at_idx" ON "token_allocations"("user_id", "allocated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "token_allocations_user_client_request_key" ON "token_allocations"("user_id", "client_request_id");

-- CreateIndex
CREATE INDEX "token_buybacks_user_simulated_at_idx" ON "token_buybacks"("user_id", "simulated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "token_buybacks_user_client_request_key" ON "token_buybacks"("user_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "token_buybacks_allocation_id_key" ON "token_buybacks"("allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "token_burns_buyback_id_key" ON "token_burns"("buyback_id");

-- CreateIndex
CREATE INDEX "token_burns_user_burned_at_idx" ON "token_burns"("user_id", "burned_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "token_burns_user_client_request_key" ON "token_burns"("user_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "token_allocations" ADD CONSTRAINT "token_allocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_buybacks" ADD CONSTRAINT "token_buybacks_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "token_allocations"("allocation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_buybacks" ADD CONSTRAINT "token_buybacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_burns" ADD CONSTRAINT "token_burns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_burns" ADD CONSTRAINT "token_burns_buyback_id_fkey" FOREIGN KEY ("buyback_id") REFERENCES "token_buybacks"("buyback_id") ON DELETE RESTRICT ON UPDATE CASCADE;
