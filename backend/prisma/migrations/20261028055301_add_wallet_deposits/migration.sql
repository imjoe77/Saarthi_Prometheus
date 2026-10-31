-- CreateEnum
CREATE TYPE "WalletDepositStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "wallet_deposits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "status" "WalletDepositStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "provider_reference" TEXT,
    "client_request_id" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallet_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_deposits_provider_reference_key" ON "wallet_deposits"("provider_reference");

-- CreateIndex
CREATE INDEX "wallet_deposits_user_id_created_at_idx" ON "wallet_deposits"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_deposits_user_id_client_request_id_key" ON "wallet_deposits"("user_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "wallet_deposits" ADD CONSTRAINT "wallet_deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_deposits" ADD CONSTRAINT "wallet_deposits_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
