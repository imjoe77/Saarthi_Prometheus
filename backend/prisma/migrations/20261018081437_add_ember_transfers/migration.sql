-- CreateTable
CREATE TABLE "ember_transfers" (
    "transfer_id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "client_request_id" UUID NOT NULL,
    "transferred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ember_transfers_pkey" PRIMARY KEY ("transfer_id")
);

-- CreateIndex
CREATE INDEX "ember_transfers_sender_transferred_at_idx" ON "ember_transfers"("sender_user_id", "transferred_at" DESC);

-- CreateIndex
CREATE INDEX "ember_transfers_recipient_transferred_at_idx" ON "ember_transfers"("recipient_user_id", "transferred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ember_transfers_sender_client_request_key" ON "ember_transfers"("sender_user_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "ember_transfers" ADD CONSTRAINT "ember_transfers_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ember_transfers" ADD CONSTRAINT "ember_transfers_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
