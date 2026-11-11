-- AlterTable
ALTER TABLE "ActualCostEntry" DROP COLUMN "counterparty",
DROP COLUMN "sourceRef",
DROP COLUMN "sourceType",
DROP COLUMN "summary",
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vendorName" TEXT;

