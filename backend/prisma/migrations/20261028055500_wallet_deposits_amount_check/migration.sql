-- Integrity constraints Prisma cannot express.
--
-- The house pattern (Module 01, `add_strategies`) is that a column Prisma
-- believes is valid must still be invalid when written by raw SQL. A deposit
-- amount is money arriving, so a zero or negative one is not a deposit.

-- The amount of a deposit is a credit, so it is always positive. The direction
-- is not encoded in the sign.
ALTER TABLE "wallet_deposits"
    ADD CONSTRAINT "wallet_deposits_amount_positive"
    CHECK ("amount" > 0);

-- A deposit is either the caller's own request or nothing. The client request
-- id is what makes a retry idempotent, so it cannot be blank.
ALTER TABLE "wallet_deposits"
    ADD CONSTRAINT "wallet_deposits_client_request_id_not_blank"
    CHECK (length(btrim("client_request_id")) > 0);

-- Only a gateway deposit carries a provider reference, and it names exactly one
-- provider order. A manual deposit has no reference at all (NULL), which this
-- constraint permits.
ALTER TABLE "wallet_deposits"
    ADD CONSTRAINT "wallet_deposits_provider_reference_not_blank"
    CHECK ("provider_reference" IS NULL OR length(btrim("provider_reference")) > 0);
