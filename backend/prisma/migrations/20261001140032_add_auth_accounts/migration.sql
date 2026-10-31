-- CreateTable
CREATE TABLE "auth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "provider_email" TEXT,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id")
);

-- Integrity constraints Prisma cannot express. Module 01 established the
-- pattern of hand-written CHECKs in migration SQL because a column Prisma
-- believes is valid must still be invalid when written by raw SQL.

-- Only known providers may be stored. A new provider is an explicit migration,
-- so an unexpected value is a defect rather than a future feature.
ALTER TABLE "auth_accounts"
    ADD CONSTRAINT "auth_accounts_provider_known"
    CHECK ("provider" IN ('google', 'github'));

-- Normalised to lower case by the application, and stored lower case so the
-- uniqueness constraint cannot be bypassed by `Google` vs `google`.
ALTER TABLE "auth_accounts"
    ADD CONSTRAINT "auth_accounts_provider_lower_case"
    CHECK ("provider" = lower("provider"));

-- An empty identity would match no real login while still occupying the
-- (provider, provider_account_id) slot.
ALTER TABLE "auth_accounts"
    ADD CONSTRAINT "auth_accounts_provider_account_id_not_blank"
    CHECK (length(btrim("provider_account_id")) > 0);

-- CreateIndex
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_accounts_provider_provider_account_id_key" ON "auth_accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_accounts_user_id_provider_key" ON "auth_accounts"("user_id", "provider");

-- AddForeignKey
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
