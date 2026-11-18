-- 第八轮：清单成本测算大宽表
CREATE TYPE "CostEstimateStatus" AS ENUM ('PREDICTED', 'FIXED');

ALTER TABLE "Project" ADD COLUMN "defaultLaborTaxRate" DECIMAL(5,2) NOT NULL DEFAULT 3;
ALTER TABLE "Project" ADD COLUMN "defaultMaterialTaxRate" DECIMAL(5,2) NOT NULL DEFAULT 13;
ALTER TABLE "Project" ADD COLUMN "defaultSubcontractTaxRate" DECIMAL(5,2) NOT NULL DEFAULT 9;

CREATE TABLE "BoqCostEstimate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "boqItemId" TEXT NOT NULL,
    "actualQuantity" DECIMAL(24,3),
    "laborPrice" DECIMAL(18,2),
    "materialPrice" DECIMAL(18,2),
    "subcontractPrice" DECIMAL(18,2),
    "laborTaxRate" DECIMAL(5,2),
    "materialTaxRate" DECIMAL(5,2),
    "subcontractTaxRate" DECIMAL(5,2),
    "costStatus" "CostEstimateStatus" NOT NULL DEFAULT 'PREDICTED',
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BoqCostEstimate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BoqCostEstimate_boqItemId_key" ON "BoqCostEstimate"("boqItemId");
CREATE INDEX "BoqCostEstimate_projectId_costStatus_idx" ON "BoqCostEstimate"("projectId", "costStatus");

ALTER TABLE "BoqCostEstimate" ADD CONSTRAINT "BoqCostEstimate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BoqCostEstimate" ADD CONSTRAINT "BoqCostEstimate_boqItemId_fkey" FOREIGN KEY ("boqItemId") REFERENCES "ProjectBoqItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
