-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'FROZEN');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('FIAT', 'STABLECOIN', 'TOKEN');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOCK', 'UNLOCK', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "auth_user_id" TEXT,
    "email" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_balances" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "available" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "locked" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallet_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(38,18) NOT NULL,
    "available_after" DECIMAL(38,18),
    "locked_after" DECIMAL(38,18),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_user_id_key" ON "users"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_symbol_key" ON "assets"("symbol");

-- CreateIndex
CREATE INDEX "wallet_balances_asset_id_idx" ON "wallet_balances"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_balances_wallet_id_asset_id_key" ON "wallet_balances"("wallet_id", "asset_id");

-- CreateIndex
CREATE INDEX "transactions_wallet_id_created_at_idx" ON "transactions"("wallet_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_asset_id_created_at_idx" ON "transactions"("asset_id", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- Integrity constraints Prisma cannot express in its schema language.
--
-- Prisma has no CHECK constraint syntax, so these are hand-written SQL inside
-- the migration. That stays safe and reproducible because an applied migration
-- file is immutable history: Prisma never introspects or rewrites one, and a
-- later `migrate dev` diffs the schema against the live database without
-- attempting to reconcile expressions it cannot parse. A CHECK constraint
-- therefore has to be maintained deliberately - drop it only alongside the
-- matching migration.
-- ---------------------------------------------------------------------------

-- A balance splits into spendable and reserved. Neither can be negative: a
-- negative "available" is an overdraft, and a negative "locked" means a
-- reservation larger than the balance it drew from. Both mean the accounting
-- logic that wrote the row is wrong, so the database refuses them instead of
-- letting the error propagate into every later calculation.
ALTER TABLE "wallet_balances"
    ADD CONSTRAINT "wallet_balances_available_non_negative" CHECK ("available" >= 0);

ALTER TABLE "wallet_balances"
    ADD CONSTRAINT "wallet_balances_locked_non_negative" CHECK ("locked" >= 0);

-- amount is a positive magnitude; direction comes from `type`. Allowing a
-- non-positive amount would make both DEPOSIT -100 and WITHDRAWAL -100
-- representable, reintroducing exactly the sign ambiguity this design removes.
ALTER TABLE "transactions"
    ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0);

-- Post-transaction snapshots describe a balance, so they inherit the same rule.
-- NULL is permitted: a FAILED or REVERSED entry moves nothing.
ALTER TABLE "transactions"
    ADD CONSTRAINT "transactions_available_after_non_negative"
    CHECK ("available_after" IS NULL OR "available_after" >= 0);

ALTER TABLE "transactions"
    ADD CONSTRAINT "transactions_locked_after_non_negative"
    CHECK ("locked_after" IS NULL OR "locked_after" >= 0);

-- An ADJUSTMENT is a manual correction and must be attributable. Enforced in
-- the database so an unattributable correction cannot be written by any code
-- path, including raw SQL or a future client.
ALTER TABLE "transactions"
    ADD CONSTRAINT "transactions_adjustment_requires_note"
    CHECK ("type" <> 'ADJUSTMENT' OR ("note" IS NOT NULL AND length(btrim("note")) > 0));

-- Assets are reference data joined on by symbol across every module. A blank
-- or whitespace-only symbol creates a row that can never be matched at lookup.
ALTER TABLE "assets"
    ADD CONSTRAINT "assets_symbol_not_blank" CHECK (length(btrim("symbol")) > 0);

-- Note: `locked` is drawn from `available` (available + locked is the total).
-- That cross-column rule is NOT a CHECK constraint because it needs a trigger,
-- and a trigger would move accounting rules out of the application layer where
-- the master plan requires them to live. Module 03 enforces it atomically when
-- it writes balances.

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_balances" ADD CONSTRAINT "wallet_balances_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
