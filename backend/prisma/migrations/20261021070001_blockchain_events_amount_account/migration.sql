-- AlterTable
ALTER TABLE "blockchain_events" ADD COLUMN     "account" TEXT NOT NULL,
ADD COLUMN     "amount" DECIMAL(38,18) NOT NULL;
