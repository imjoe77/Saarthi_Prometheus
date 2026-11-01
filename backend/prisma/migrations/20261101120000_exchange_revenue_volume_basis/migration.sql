-- MODULE 08 x MODULE 11, volume-linked sizing: the tokenomics basis column.
--
-- `revenue_inr` answers one question and keeps answering only that: how much
-- did this settlement make Prometheus. `basis_inr` answers a different one: how
-- much was the burn engine sized against. Under RETAINED_BPS the two are equal.
-- Under VOLUME_LINKED the basis is the order's own INR value while revenue
-- stays zero, because trading volume is not income and this table must not be
-- made to imply that it is.
--
-- The backfill copies revenue, so every row written before this column existed
-- keeps exactly the meaning it had when it was written. Purely additive: no
-- existing column, constraint or relation is touched.

ALTER TABLE "exchange_revenue_events"
    ADD COLUMN "basis_inr" DECIMAL(38,18) NOT NULL DEFAULT 0;

UPDATE "exchange_revenue_events"
   SET "basis_inr" = "revenue_inr";
