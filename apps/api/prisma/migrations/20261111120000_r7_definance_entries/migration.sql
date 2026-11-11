-- 第七轮：实际成本去财务化（成本说明 / 供应商 / 结算周期），移除发票与来源单据
ALTER TABLE "ActualCostEntry"
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "vendorName" TEXT;

-- 旧数据回填：摘要 → 成本说明；交易对象 → 供应商/分包商
UPDATE "ActualCostEntry" SET "description" = "summary";
UPDATE "ActualCostEntry" SET "vendorName" = "counterparty" WHERE "counterparty" IS NOT NULL AND "counterparty" <> '';

ALTER TABLE "ActualCostEntry"
  DROP COLUMN "counterparty",
  DROP COLUMN "sourceRef",
  DROP COLUMN "sourceType",
  DROP COLUMN "summary";