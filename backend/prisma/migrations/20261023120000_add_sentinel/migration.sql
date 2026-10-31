-- MODULE 14 - Sentinel: price monitoring and automated voice alerts.
-- Three tables and nothing else. Money and RBAC are untouched.

-- CreateEnum
CREATE TYPE "SentinelAlertStatus" AS ENUM ('ACTIVE', 'TRIGGERED', 'CALL_QUEUED', 'CALLING', 'CALL_COMPLETED', 'CALL_FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SentinelTriggerCondition" AS ENUM ('GREATER_THAN_OR_EQUAL', 'LESS_THAN_OR_EQUAL');

-- CreateEnum
CREATE TYPE "SentinelCallStatus" AS ENUM ('QUEUED', 'INITIATED', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'REJECTED', 'CANCELED', 'FAILED');

-- CreateTable
CREATE TABLE "sentinel_alerts" (
    "alert_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "target_price" DECIMAL(38,18) NOT NULL,
    "condition" "SentinelTriggerCondition" NOT NULL,
    "status" "SentinelAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "voice_enabled" BOOLEAN NOT NULL DEFAULT true,
    "observed_price" DECIMAL(38,18),
    "observed_as_of" TIMESTAMPTZ(3),
    "observed_provider" TEXT,
    "observed_market_state" TEXT,
    "observed_stale" BOOLEAN,
    "last_evaluated_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "call_skip_reason" TEXT,
    "triggered_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "expired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sentinel_alerts_pkey" PRIMARY KEY ("alert_id")
);

-- CreateTable
CREATE TABLE "sentinel_voice_settings" (
    "user_id" UUID NOT NULL,
    "phone_e164" TEXT,
    "phone_verified_at" TIMESTAMPTZ(3),
    "verification_code_hash" TEXT,
    "verification_expires_at" TIMESTAMPTZ(3),
    "verification_attempts" INTEGER NOT NULL DEFAULT 0,
    "consent_at" TIMESTAMPTZ(3),
    "consent_withdrawn_at" TIMESTAMPTZ(3),
    "voice_disabled_at" TIMESTAMPTZ(3),
    "quiet_hours_start_utc" INTEGER,
    "quiet_hours_end_utc" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sentinel_voice_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sentinel_voice_calls" (
    "call_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "status" "SentinelCallStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_call_id" TEXT,
    "spoken_text" TEXT,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "initiated_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3),
    "fail_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sentinel_voice_calls_pkey" PRIMARY KEY ("call_id")
);

-- CreateIndex
CREATE INDEX "sentinel_alerts_owner_created_at_idx" ON "sentinel_alerts"("owner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sentinel_alerts_status_expires_at_idx" ON "sentinel_alerts"("status", "expires_at");

-- CreateIndex
CREATE INDEX "sentinel_alerts_owner_status_idx" ON "sentinel_alerts"("owner_id", "status");

-- CreateIndex
CREATE INDEX "sentinel_voice_calls_status_queued_at_idx" ON "sentinel_voice_calls"("status", "queued_at");

-- CreateIndex
CREATE INDEX "sentinel_voice_calls_status_next_attempt_at_idx" ON "sentinel_voice_calls"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "sentinel_voice_calls_alert_id_idx" ON "sentinel_voice_calls"("alert_id");

-- CreateIndex
CREATE UNIQUE INDEX "sentinel_voice_calls_alert_id_key" ON "sentinel_voice_calls"("alert_id");

-- CreateIndex
CREATE UNIQUE INDEX "sentinel_voice_calls_provider_call_id_key" ON "sentinel_voice_calls"("provider_call_id");

-- AddForeignKey
ALTER TABLE "sentinel_alerts" ADD CONSTRAINT "sentinel_alerts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentinel_voice_settings" ADD CONSTRAINT "sentinel_voice_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentinel_voice_calls" ADD CONSTRAINT "sentinel_voice_calls_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "sentinel_alerts"("alert_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraints
ALTER TABLE "sentinel_voice_calls" ADD CONSTRAINT "sentinel_voice_calls_max_attempts_positive_chk" CHECK ("max_attempts" > 0 AND "attempts" >= 0);
ALTER TABLE "sentinel_voice_settings" ADD CONSTRAINT "sentinel_voice_settings_quiet_hours_range_chk" CHECK (("quiet_hours_start_utc" IS NULL AND "quiet_hours_end_utc" IS NULL) OR ("quiet_hours_start_utc" BETWEEN 0 AND 1439 AND "quiet_hours_end_utc" BETWEEN 0 AND 1439));
ALTER TABLE "sentinel_alerts" ADD CONSTRAINT "sentinel_alerts_expires_after_created_chk" CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");
