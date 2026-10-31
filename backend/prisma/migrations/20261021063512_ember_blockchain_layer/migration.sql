-- CreateEnum
CREATE TYPE "EmberMintStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "OnChainStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "BlockchainEventType" AS ENUM ('TokensMinted', 'TokensBurned');

-- CreateEnum
CREATE TYPE "EmberPurchaseStatus" AS ENUM ('COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmberStakeStatus" AS ENUM ('ACTIVE', 'UNSTAKED');

-- AlterTable
ALTER TABLE "token_burns" ADD COLUMN     "on_chain_block_number" BIGINT,
ADD COLUMN     "on_chain_status" "OnChainStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "on_chain_tx_hash" TEXT,
ADD COLUMN     "on_chain_updated_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "ember_mint_requests" (
    "mint_request_id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "status" "EmberMintStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "reason" TEXT,
    "network" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tx_hash" TEXT,
    "block_number" BIGINT,
    "error_message" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ember_mint_requests_pkey" PRIMARY KEY ("mint_request_id")
);

-- CreateTable
CREATE TABLE "blockchain_events" (
    "id" UUID NOT NULL,
    "network" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "block_number" BIGINT NOT NULL,
    "log_index" INTEGER NOT NULL,
    "event_type" "BlockchainEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "mint_request_id" UUID,
    "burnId" UUID,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blockchain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ember_purchases" (
    "purchase_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ember_amount" DECIMAL(38,18) NOT NULL,
    "ember_price_inr" DECIMAL(38,18) NOT NULL,
    "total_inr" DECIMAL(38,18) NOT NULL,
    "usdt_rate_inr" DECIMAL(38,18) NOT NULL,
    "total_usdt" DECIMAL(38,18) NOT NULL,
    "status" "EmberPurchaseStatus" NOT NULL DEFAULT 'COMPLETED',
    "client_request_id" UUID NOT NULL,
    "failed_reason" TEXT,
    "purchased_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_at" TIMESTAMPTZ(3),

    CONSTRAINT "ember_purchases_pkey" PRIMARY KEY ("purchase_id")
);

-- CreateTable
CREATE TABLE "ember_stake_positions" (
    "stake_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "status" "EmberStakeStatus" NOT NULL DEFAULT 'ACTIVE',
    "lock_until" TIMESTAMPTZ(3) NOT NULL,
    "client_request_id" UUID NOT NULL,
    "staked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unstaked_at" TIMESTAMPTZ(3),

    CONSTRAINT "ember_stake_positions_pkey" PRIMARY KEY ("stake_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ember_mint_requests_requestId_key" ON "ember_mint_requests"("requestId");

-- CreateIndex
CREATE INDEX "ember_mint_requests_status_requested_at_idx" ON "ember_mint_requests"("status", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_events_mint_request_id_key" ON "blockchain_events"("mint_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_events_burnId_key" ON "blockchain_events"("burnId");

-- CreateIndex
CREATE INDEX "blockchain_events_type_block_idx" ON "blockchain_events"("event_type", "block_number");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_events_chain_tx_log_key" ON "blockchain_events"("chainId", "tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "ember_purchases_user_purchased_at_idx" ON "ember_purchases"("user_id", "purchased_at" DESC);

-- CreateIndex
CREATE INDEX "ember_purchases_status_purchased_at_idx" ON "ember_purchases"("status", "purchased_at");

-- CreateIndex
CREATE UNIQUE INDEX "ember_purchases_user_client_request_key" ON "ember_purchases"("user_id", "client_request_id");

-- CreateIndex
CREATE INDEX "ember_stake_positions_user_staked_at_idx" ON "ember_stake_positions"("user_id", "staked_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ember_stake_positions_user_client_request_key" ON "ember_stake_positions"("user_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "token_burns_on_chain_tx_hash_key" ON "token_burns"("on_chain_tx_hash");

-- AddForeignKey
ALTER TABLE "ember_mint_requests" ADD CONSTRAINT "ember_mint_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_events" ADD CONSTRAINT "blockchain_events_mint_request_id_fkey" FOREIGN KEY ("mint_request_id") REFERENCES "ember_mint_requests"("mint_request_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_events" ADD CONSTRAINT "blockchain_events_burnId_fkey" FOREIGN KEY ("burnId") REFERENCES "token_burns"("burn_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ember_purchases" ADD CONSTRAINT "ember_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ember_stake_positions" ADD CONSTRAINT "ember_stake_positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraints
ALTER TABLE "ember_mint_requests" ADD CONSTRAINT "ember_mint_requests_amount_positive_chk" CHECK ("amount" > 0);
ALTER TABLE "ember_purchases" ADD CONSTRAINT "ember_purchases_amounts_positive_chk" CHECK ("ember_amount" > 0 AND "ember_price_inr" > 0 AND "total_inr" > 0 AND "total_usdt" > 0 AND "usdt_rate_inr" > 0);
ALTER TABLE "ember_stake_positions" ADD CONSTRAINT "ember_stake_positions_amount_positive_chk" CHECK ("amount" > 0);
