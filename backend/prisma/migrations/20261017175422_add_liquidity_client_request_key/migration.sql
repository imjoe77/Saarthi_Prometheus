/*
  Warnings:

  - Added the required column `client_request_id` to the `liquidity_commitments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "liquidity_commitments" ADD COLUMN     "client_request_id" UUID NOT NULL;
