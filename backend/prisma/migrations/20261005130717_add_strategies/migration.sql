-- CreateEnum
CREATE TYPE "StrategyVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "StrategyStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "strategies" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "StrategyVisibility" NOT NULL DEFAULT 'PRIVATE',
    "status" "StrategyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);

-- Integrity constraints Prisma cannot express. Module 01 established the
-- pattern of hand-written CHECKs in migration SQL because a column Prisma
-- believes is valid must still be invalid when written by raw SQL.

-- An empty name would render as an unusable label and would still occupy the
-- owner's one-name slot. `btrim` so a run of spaces is treated as empty.
ALTER TABLE "strategies"
    ADD CONSTRAINT "strategies_name_not_blank"
    CHECK (length(btrim("name")) > 0);

-- A name is a label, not prose. 80 characters is longer than any name a human
-- would read at a glance and short enough to keep one on a single row.
ALTER TABLE "strategies"
    ADD CONSTRAINT "strategies_name_length"
    CHECK (length("name") <= 80);

-- The description is the one free-text field this module allows, so it is
-- bounded explicitly rather than left to whatever TEXT accepts.
ALTER TABLE "strategies"
    ADD CONSTRAINT "strategies_description_length"
    CHECK ("description" IS NULL OR length("description") <= 1000);

-- Case-insensitive uniqueness: one name per owner.
--
-- `lower(btrim(...))` because both transformations are part of the rule the
-- application enforces (it trims and compares case-insensitively), so a row
-- written by raw SQL cannot occupy a second slot under a different spelling.
--
-- A functional index cannot be declared in schema.prisma - the schema language
-- has no expression indexes - which is why this is hand-written here. It is
-- deliberately NOT modelled as `@@unique([ownerId, name])`: that would advertise
-- a case-sensitive lookup that no query in the application performs, and Prisma
-- would then try to reconcile the two on the next migration run.
--
-- The caveat this accepts: `lower()` follows the database collation, so two
-- names that differ only by a character the collation folds (and which the
-- application does not) would be treated as equal here and be refused.
-- Over-refusing one name is the safe direction; the reverse would not be.
CREATE UNIQUE INDEX "strategies_owner_id_lower_name_key"
    ON "strategies"("owner_id", lower(btrim("name")));

-- CreateIndex
CREATE INDEX "strategies_owner_id_created_at_idx" ON "strategies"("owner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "strategies_visibility_status_created_at_idx" ON "strategies"("visibility", "status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
