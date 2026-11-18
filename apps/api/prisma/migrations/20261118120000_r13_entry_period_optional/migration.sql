-- 第十三轮：成本周期改为可空（总账台账不记录周期，仅过程流水记录）
ALTER TABLE "ActualCostEntry" ALTER COLUMN "period" DROP NOT NULL;
