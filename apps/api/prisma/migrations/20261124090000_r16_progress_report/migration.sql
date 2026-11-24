-- 第十六轮：过程报量（期次 / 清单报量行 / 签证及其他确认行）

CREATE TABLE "ProgressPeriod" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressPeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProgressBoqLine" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "boqItemId" TEXT NOT NULL,
    "prevCumQty" DECIMAL(24,3) NOT NULL DEFAULT 0,
    "confirmedCumQty" DECIMAL(24,3) NOT NULL DEFAULT 0,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressBoqLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProgressExtraLine" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prevCumAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "confirmedCumAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "remark" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgressExtraLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProgressPeriod_projectId_period_key" ON "ProgressPeriod"("projectId", "period");
CREATE INDEX "ProgressPeriod_projectId_period_idx" ON "ProgressPeriod"("projectId", "period");

CREATE UNIQUE INDEX "ProgressBoqLine_periodId_boqItemId_key" ON "ProgressBoqLine"("periodId", "boqItemId");
CREATE INDEX "ProgressBoqLine_boqItemId_idx" ON "ProgressBoqLine"("boqItemId");

CREATE INDEX "ProgressExtraLine_periodId_idx" ON "ProgressExtraLine"("periodId");

ALTER TABLE "ProgressPeriod" ADD CONSTRAINT "ProgressPeriod_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgressBoqLine" ADD CONSTRAINT "ProgressBoqLine_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ProgressPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgressBoqLine" ADD CONSTRAINT "ProgressBoqLine_boqItemId_fkey" FOREIGN KEY ("boqItemId") REFERENCES "ProjectBoqItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgressExtraLine" ADD CONSTRAINT "ProgressExtraLine_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ProgressPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
