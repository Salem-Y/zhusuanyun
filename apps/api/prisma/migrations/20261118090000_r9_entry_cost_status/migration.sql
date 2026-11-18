-- 第九轮：台账成本明细增加成本状态（预测 / 已定标）
ALTER TABLE "ActualCostEntry" ADD COLUMN "costStatus" "CostEstimateStatus" NOT NULL DEFAULT 'PREDICTED';
