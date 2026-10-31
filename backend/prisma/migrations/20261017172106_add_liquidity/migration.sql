-- CreateEnum
CREATE TYPE "LiquidityProviderStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "LiquidityCommitmentStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "LiquidityTopUpStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "liquidity_providers" (
    "lp_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "LiquidityProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidity_providers_pkey" PRIMARY KEY ("lp_id")
);

-- CreateTable
CREATE TABLE "liquidity_commitments" (
    "commitment_id" UUID NOT NULL,
    "lp_id" UUID NOT NULL,
    "usdt_committed" DECIMAL(38,18) NOT NULL,
    "usdt_consumed" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "usdt_available" DECIMAL(38,18) NOT NULL,
    "ember_locked" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "status" "LiquidityCommitmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "committed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "liquidity_commitments_pkey" PRIMARY KEY ("commitment_id")
);

-- CreateTable
CREATE TABLE "liquidity_allocations" (
    "allocation_id" UUID NOT NULL,
    "commitment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "usdt_amount" DECIMAL(38,18) NOT NULL,
    "price_inr" DECIMAL(38,18) NOT NULL,
    "allocated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidity_allocations_pkey" PRIMARY KEY ("allocation_id")
);

-- CreateTable
CREATE TABLE "liquidity_commitment_reductions" (
    "reduction_id" UUID NOT NULL,
    "commitment_id" UUID NOT NULL,
    "usdt_amount" DECIMAL(38,18) NOT NULL,
    "ember_unlocked" DECIMAL(38,18) NOT NULL,
    "client_request_id" UUID NOT NULL,
    "reduced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidity_commitment_reductions_pkey" PRIMARY KEY ("reduction_id")
);

-- CreateTable
CREATE TABLE "liquidity_top_up_requests" (
    "top_up_request_id" UUID NOT NULL,
    "required_usdt" DECIMAL(38,18) NOT NULL,
    "threshold_usdt" DECIMAL(38,18) NOT NULL,
    "status" "LiquidityTopUpStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "liquidity_top_up_requests_pkey" PRIMARY KEY ("top_up_request_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "liquidity_providers_user_id_key" ON "liquidity_providers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "liquidity_commitments_lp_id_key" ON "liquidity_commitments"("lp_id");

-- CreateIndex
CREATE INDEX "liquidity_commitments_status_committed_at_idx" ON "liquidity_commitments"("status", "committed_at");

-- CreateIndex
CREATE UNIQUE INDEX "liquidity_allocations_order_id_commitment_id_key" ON "liquidity_allocations"("order_id", "commitment_id");

-- CreateIndex
CREATE UNIQUE INDEX "liquidity_reductions_commitment_client_request_key" ON "liquidity_commitment_reductions"("commitment_id", "client_request_id");

-- CreateIndex
CREATE INDEX "liquidity_top_up_requests_status_opened_at_idx" ON "liquidity_top_up_requests"("status", "opened_at");

-- AddForeignKey
ALTER TABLE "liquidity_providers" ADD CONSTRAINT "liquidity_providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidity_commitments" ADD CONSTRAINT "liquidity_commitments_lp_id_fkey" FOREIGN KEY ("lp_id") REFERENCES "liquidity_providers"("lp_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidity_allocations" ADD CONSTRAINT "liquidity_allocations_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "liquidity_commitments"("commitment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidity_allocations" ADD CONSTRAINT "liquidity_allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "usdt_orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidity_commitment_reductions" ADD CONSTRAINT "liquidity_commitment_reductions_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "liquidity_commitments"("commitment_id") ON DELETE RESTRICT ON UPDATE CASCADE;
