-- Module 06c cleanup: remove the implicit foreign keys Prisma inferred from a
-- `PaperAccount.orders/positions` back-relation that the design does not need.
--
-- Orders and positions reach their paper account through `strategies` (their
-- shared `strategy_id`), so the extra `paperAccountStrategyId` columns added by
-- the `add_paper_trading` migration are dead weight and are dropped here. No
-- application code ever referenced them.
ALTER TABLE "paper_positions" DROP CONSTRAINT "paper_positions_paperAccountStrategyId_fkey";
ALTER TABLE "paper_orders" DROP CONSTRAINT "paper_orders_paperAccountStrategyId_fkey";
ALTER TABLE "paper_orders" DROP COLUMN "paperAccountStrategyId";
ALTER TABLE "paper_positions" DROP COLUMN "paperAccountStrategyId";