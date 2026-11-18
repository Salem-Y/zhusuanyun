﻿-- CreateEnum
CREATE TYPE "BoqProjectCategory" AS ENUM ('divisional', 'measure', 'other');

-- AlterEnum
ALTER TYPE "ExpenseCategory" ADD VALUE 'other';

-- AlterTable
ALTER TABLE "ActualCostEntry" ADD COLUMN     "amountTaxExcl" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "amountTaxIncl" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "priceTaxIncl" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "taxRate" DECIMAL(5,2),
ADD COLUMN     "unitPriceTaxExcl" DECIMAL(18,2),
ADD COLUMN     "unitPriceTaxIncl" DECIMAL(18,2),
ADD COLUMN     "unitProjectId" TEXT,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(24,3),
ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "revenueTaxRate" DECIMAL(5,2) NOT NULL DEFAULT 9;

-- AlterTable
ALTER TABLE "ProjectBoqItem" ADD COLUMN     "projectCategory" "BoqProjectCategory" NOT NULL DEFAULT 'divisional',
ADD COLUMN     "taxRate" DECIMAL(5,2),
ADD COLUMN     "unitProjectId" TEXT,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(24,3);

-- AlterTable
ALTER TABLE "TargetCostLine" ADD COLUMN     "amountTaxExcl" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "amountTaxIncl" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "priceTaxIncl" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "taxRate" DECIMAL(5,2),
ADD COLUMN     "unitPriceTaxExcl" DECIMAL(18,2),
ADD COLUMN     "unitPriceTaxIncl" DECIMAL(18,2),
ADD COLUMN     "unitProjectId" TEXT,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(24,3),
ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(18,2);

-- CreateTable
CREATE TABLE "ProjectUnit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectUnit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectUnit_projectId_isActive_idx" ON "ProjectUnit"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectUnit_projectId_name_key" ON "ProjectUnit"("projectId", "name");

-- CreateIndex
CREATE INDEX "ActualCostEntry_unitProjectId_idx" ON "ActualCostEntry"("unitProjectId");

-- CreateIndex
CREATE INDEX "ProjectBoqItem_projectId_projectCategory_idx" ON "ProjectBoqItem"("projectId", "projectCategory");

-- CreateIndex
CREATE INDEX "ProjectBoqItem_unitProjectId_idx" ON "ProjectBoqItem"("unitProjectId");

-- CreateIndex
CREATE INDEX "TargetCostLine_unitProjectId_idx" ON "TargetCostLine"("unitProjectId");

-- AddForeignKey
ALTER TABLE "ProjectUnit" ADD CONSTRAINT "ProjectUnit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBoqItem" ADD CONSTRAINT "ProjectBoqItem_unitProjectId_fkey" FOREIGN KEY ("unitProjectId") REFERENCES "ProjectUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetCostLine" ADD CONSTRAINT "TargetCostLine_unitProjectId_fkey" FOREIGN KEY ("unitProjectId") REFERENCES "ProjectUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualCostEntry" ADD CONSTRAINT "ActualCostEntry_unitProjectId_fkey" FOREIGN KEY ("unitProjectId") REFERENCES "ProjectUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 第六轮：旧数据回填（历史明细按税率 0 处理，含税=不含税=原金额；此处如实保留原值，不做税收换算）
UPDATE "TargetCostLine" SET "amountTaxExcl" = "amount", "amountTaxIncl" = "amount" WHERE "amountTaxExcl" = 0 AND "amount" <> 0;
UPDATE "ActualCostEntry" SET "amountTaxExcl" = "amount", "amountTaxIncl" = "amount" WHERE "amountTaxExcl" = 0 AND "amount" <> 0;

