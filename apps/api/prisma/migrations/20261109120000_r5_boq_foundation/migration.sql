-- CreateEnum
CREATE TYPE "BoqItemSource" AS ENUM ('manual', 'import');

-- CreateEnum
CREATE TYPE "BoqItemStatus" AS ENUM ('active', 'merged', 'void');

-- AlterTable（先删除 CostCode.category，解除对旧枚举的依赖，否则下方 DROP TYPE 失败）
ALTER TABLE "CostCode" DROP COLUMN "category";

-- AlterEnum
BEGIN;
CREATE TYPE "ExpenseCategory_new" AS ENUM ('labor', 'material', 'machine', 'subcontract', 'turnover', 'measure', 'site_overhead');
ALTER TABLE "TargetCostLine" ALTER COLUMN "category" TYPE "ExpenseCategory_new" USING ("category"::text::"ExpenseCategory_new");
ALTER TABLE "ActualCostEntry" ALTER COLUMN "category" TYPE "ExpenseCategory_new" USING ("category"::text::"ExpenseCategory_new");
ALTER TYPE "ExpenseCategory" RENAME TO "ExpenseCategory_old";
ALTER TYPE "ExpenseCategory_new" RENAME TO "ExpenseCategory";
DROP TYPE "public"."ExpenseCategory_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "ActualCostEntry" DROP CONSTRAINT "ActualCostEntry_costCodeId_fkey";

-- DropForeignKey
ALTER TABLE "ActualCostEntry" DROP CONSTRAINT "ActualCostEntry_workPackageId_fkey";

-- DropForeignKey
ALTER TABLE "TargetCostLine" DROP CONSTRAINT "TargetCostLine_costCodeId_fkey";

-- DropForeignKey
ALTER TABLE "TargetCostLine" DROP CONSTRAINT "TargetCostLine_workPackageId_fkey";

-- DropIndex
DROP INDEX "ActualCostEntry_costCodeId_idx";

-- DropIndex
DROP INDEX "ActualCostEntry_workPackageId_idx";

-- DropIndex
DROP INDEX "TargetCostLine_costCodeId_idx";

-- DropIndex
DROP INDEX "TargetCostLine_workPackageId_idx";

-- AlterTable
ALTER TABLE "ActualCostEntry" DROP COLUMN "costCodeId",
DROP COLUMN "workPackageId",
ADD COLUMN     "boqItemId" TEXT;

-- AlterTable
ALTER TABLE "TargetCostLine" DROP COLUMN "costCodeId",
DROP COLUMN "costCodeName",
DROP COLUMN "workPackageId",
DROP COLUMN "workPackageName",
ADD COLUMN     "boqItemId" TEXT,
ADD COLUMN     "boqItemName" TEXT;

-- CreateTable
CREATE TABLE "ProjectBoqItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sectionCode" TEXT,
    "sectionName" TEXT,
    "itemName" TEXT NOT NULL,
    "itemFeature" TEXT,
    "unit" TEXT,
    "quantity" DECIMAL(24,6),
    "unitPriceTaxIncl" DECIMAL(18,2),
    "unitPriceTaxExcl" DECIMAL(18,2),
    "amountTaxIncl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountTaxExcl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "source" "BoqItemSource" NOT NULL DEFAULT 'manual',
    "status" "BoqItemStatus" NOT NULL DEFAULT 'active',
    "mergedIntoId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectBoqItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportMappingTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportMappingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportLog" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "templateId" TEXT,
    "headerJson" JSONB,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBoqItem_idempotencyKey_key" ON "ProjectBoqItem"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProjectBoqItem_projectId_status_idx" ON "ProjectBoqItem"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportMappingTemplate_projectId_name_key" ON "ImportMappingTemplate"("projectId", "name");

-- CreateIndex
CREATE INDEX "ImportLog_projectId_createdAt_idx" ON "ImportLog"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ActualCostEntry_boqItemId_idx" ON "ActualCostEntry"("boqItemId");

-- CreateIndex
CREATE INDEX "TargetCostLine_boqItemId_idx" ON "TargetCostLine"("boqItemId");

-- AddForeignKey
ALTER TABLE "ProjectBoqItem" ADD CONSTRAINT "ProjectBoqItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBoqItem" ADD CONSTRAINT "ProjectBoqItem_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "ProjectBoqItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportMappingTemplate" ADD CONSTRAINT "ImportMappingTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportLog" ADD CONSTRAINT "ImportLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetCostLine" ADD CONSTRAINT "TargetCostLine_boqItemId_fkey" FOREIGN KEY ("boqItemId") REFERENCES "ProjectBoqItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_boqItemId_fkey" FOREIGN KEY ("boqItemId") REFERENCES "ProjectBoqItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

