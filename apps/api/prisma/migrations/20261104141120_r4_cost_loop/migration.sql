-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('LABOR', 'MATERIAL', 'MACHINERY', 'SUBCONTRACT', 'MEASURE', 'OTHER');

-- CreateEnum
CREATE TYPE "PricingMethod" AS ENUM ('QTY_PRICE', 'LUMP_SUM');

-- CreateEnum
CREATE TYPE "TargetVersionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ActualEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ActualEntryKind" AS ENUM ('NORMAL', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ReversalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CostSourceType" AS ENUM ('INVOICE', 'SETTLEMENT', 'PAYROLL', 'CONTRACT', 'OTHER');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "costCaliberNote" TEXT;

-- CreateTable
CREATE TABLE "WorkPackage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isCommon" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCode" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetCostVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionName" TEXT NOT NULL,
    "description" TEXT,
    "caliberText" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "status" "TargetVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "isAdjustment" BOOLEAN NOT NULL DEFAULT false,
    "baseVersionId" TEXT,
    "adjustReason" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "submittedById" TEXT,
    "submittedByName" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetCostVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetCostLine" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "workPackageId" TEXT NOT NULL,
    "costCodeId" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "summary" TEXT NOT NULL,
    "pricingMethod" "PricingMethod" NOT NULL,
    "quantity" DECIMAL(24,6),
    "unit" TEXT,
    "unitPrice" DECIMAL(24,6),
    "amount" DECIMAL(18,2) NOT NULL,
    "basisNote" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "workPackageName" TEXT,
    "costCodeName" TEXT,

    CONSTRAINT "TargetCostLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActualCostEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workPackageId" TEXT NOT NULL,
    "costCodeId" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "period" TEXT NOT NULL,
    "periodReason" TEXT,
    "summary" TEXT NOT NULL,
    "pricingMethod" "PricingMethod" NOT NULL,
    "quantity" DECIMAL(24,6),
    "unit" TEXT,
    "unitPrice" DECIMAL(24,6),
    "amount" DECIMAL(18,2) NOT NULL,
    "counterparty" TEXT,
    "sourceType" "CostSourceType" NOT NULL,
    "sourceRef" TEXT,
    "basisNote" TEXT,
    "kind" "ActualEntryKind" NOT NULL DEFAULT 'NORMAL',
    "status" "ActualEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "submittedById" TEXT,
    "submittedByName" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "reversalOfId" TEXT,
    "reversedById" TEXT,
    "replaceOfId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActualCostEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostReversalRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReversalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "reversalEntryId" TEXT,
    "idempotencyKey" TEXT,

    CONSTRAINT "CostReversalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkPackage_projectId_idx" ON "WorkPackage"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkPackage_projectId_code_key" ON "WorkPackage"("projectId", "code");

-- CreateIndex
CREATE INDEX "CostCode_projectId_idx" ON "CostCode"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CostCode_projectId_code_key" ON "CostCode"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "TargetCostVersion_idempotencyKey_key" ON "TargetCostVersion"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TargetCostVersion_projectId_status_idx" ON "TargetCostVersion"("projectId", "status");

-- CreateIndex
CREATE INDEX "TargetCostVersion_projectId_isCurrent_idx" ON "TargetCostVersion"("projectId", "isCurrent");

-- CreateIndex
CREATE INDEX "TargetCostLine_versionId_idx" ON "TargetCostLine"("versionId");

-- CreateIndex
CREATE INDEX "TargetCostLine_workPackageId_idx" ON "TargetCostLine"("workPackageId");

-- CreateIndex
CREATE INDEX "TargetCostLine_costCodeId_idx" ON "TargetCostLine"("costCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "ActualCostEntry_reversalOfId_key" ON "ActualCostEntry"("reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "ActualCostEntry_reversedById_key" ON "ActualCostEntry"("reversedById");

-- CreateIndex
CREATE UNIQUE INDEX "ActualCostEntry_idempotencyKey_key" ON "ActualCostEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ActualCostEntry_projectId_status_idx" ON "ActualCostEntry"("projectId", "status");

-- CreateIndex
CREATE INDEX "ActualCostEntry_projectId_businessDate_idx" ON "ActualCostEntry"("projectId", "businessDate");

-- CreateIndex
CREATE INDEX "ActualCostEntry_workPackageId_idx" ON "ActualCostEntry"("workPackageId");

-- CreateIndex
CREATE INDEX "ActualCostEntry_costCodeId_idx" ON "ActualCostEntry"("costCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "CostReversalRequest_idempotencyKey_key" ON "CostReversalRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CostReversalRequest_projectId_status_idx" ON "CostReversalRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "CostReversalRequest_entryId_idx" ON "CostReversalRequest"("entryId");

-- AddForeignKey
ALTER TABLE "WorkPackage" ADD CONSTRAINT "WorkPackage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCode" ADD CONSTRAINT "CostCode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetCostVersion" ADD CONSTRAINT "TargetCostVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetCostVersion" ADD CONSTRAINT "TargetCostVersion_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "TargetCostVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetCostLine" ADD CONSTRAINT "TargetCostLine_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "TargetCostVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetCostLine" ADD CONSTRAINT "TargetCostLine_workPackageId_fkey" FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetCostLine" ADD CONSTRAINT "TargetCostLine_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_workPackageId_fkey" FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_costCodeId_fkey" FOREIGN KEY ("costCodeId") REFERENCES "CostCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "ActualCostEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostReversalRequest" ADD CONSTRAINT "CostReversalRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostReversalRequest" ADD CONSTRAINT "CostReversalRequest_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ActualCostEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
