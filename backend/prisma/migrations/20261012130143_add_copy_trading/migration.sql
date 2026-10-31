-- CreateEnum
CREATE TYPE "FollowStatus" AS ENUM ('ACTIVE', 'UNFOLLOWED');

-- CreateEnum
CREATE TYPE "CopyEventStatus" AS ENUM ('COPIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CopyRejectReason" AS ENUM ('FOLLOW_NOT_ACTIVE', 'STRATEGY_ARCHIVED', 'STRATEGY_NOT_ELIGIBLE', 'ALLOCATION_ROUNDED_TO_ZERO', 'INSUFFICIENT_COPY_CASH', 'INSUFFICIENT_POSITION', 'PRICE_UNAVAILABLE');

-- CreateTable
CREATE TABLE "strategy_follows" (
    "follower_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "status" "FollowStatus" NOT NULL DEFAULT 'ACTIVE',
    "allocation_fraction" DECIMAL(38,18) NOT NULL,
    "followed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unfollowed_at" TIMESTAMPTZ(3),
    "cursor_filled_at" TIMESTAMPTZ(3),
    "cursor_order_id" UUID,
    "last_processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "strategy_follows_pkey" PRIMARY KEY ("follower_id","strategy_id")
);

-- CreateTable
CREATE TABLE "copy_accounts" (
    "follower_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "cash" DECIMAL(38,18) NOT NULL DEFAULT 100000,
    "realized_pnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "copy_accounts_pkey" PRIMARY KEY ("follower_id","strategy_id")
);

-- CreateTable
CREATE TABLE "copy_positions" (
    "follower_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "average_entry_price" DECIMAL(38,18) NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "copy_positions_pkey" PRIMARY KEY ("follower_id","strategy_id","symbol")
);

-- CreateTable
CREATE TABLE "copy_events" (
    "follower_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "expert_order_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "PaperOrderSide" NOT NULL,
    "expert_quantity" DECIMAL(38,18) NOT NULL,
    "expert_fill_price" DECIMAL(38,18) NOT NULL,
    "expert_filled_at" TIMESTAMPTZ(3) NOT NULL,
    "allocation_fraction" DECIMAL(38,18) NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "fill_price" DECIMAL(38,18),
    "gross" DECIMAL(38,18),
    "status" "CopyEventStatus" NOT NULL,
    "reject_reason" "CopyRejectReason",
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copy_events_pkey" PRIMARY KEY ("follower_id","strategy_id","expert_order_id")
);

-- CreateIndex
CREATE INDEX "strategy_follows_strategy_id_status_idx" ON "strategy_follows"("strategy_id", "status");

-- CreateIndex
CREATE INDEX "strategy_follows_follower_id_followed_at_idx" ON "strategy_follows"("follower_id", "followed_at" DESC);

-- CreateIndex
CREATE INDEX "copy_events_follower_id_strategy_id_processed_at_idx" ON "copy_events"("follower_id", "strategy_id", "processed_at" DESC);

-- CreateIndex
CREATE INDEX "copy_events_follower_id_strategy_id_status_idx" ON "copy_events"("follower_id", "strategy_id", "status");

-- AddForeignKey
ALTER TABLE "strategy_follows" ADD CONSTRAINT "strategy_follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_follows" ADD CONSTRAINT "strategy_follows_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_accounts" ADD CONSTRAINT "copy_accounts_follower_id_strategy_id_fkey" FOREIGN KEY ("follower_id", "strategy_id") REFERENCES "strategy_follows"("follower_id", "strategy_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_positions" ADD CONSTRAINT "copy_positions_follower_id_strategy_id_fkey" FOREIGN KEY ("follower_id", "strategy_id") REFERENCES "strategy_follows"("follower_id", "strategy_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copy_events" ADD CONSTRAINT "copy_events_follower_id_strategy_id_fkey" FOREIGN KEY ("follower_id", "strategy_id") REFERENCES "strategy_follows"("follower_id", "strategy_id") ON DELETE RESTRICT ON UPDATE CASCADE;
