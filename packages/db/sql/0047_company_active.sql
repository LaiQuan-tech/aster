-- 2026-10-10 公司主體可停用：停用後新專案／放款／下包付款的下拉不再出現，舊紀錄照常顯示。
-- 前提：已套到 0056（sql/0046）。可重跑。從沒被引用的公司由 API 允許刪除（不需 DB 變更；
-- 外鍵 NO ACTION 會擋下已被引用者）。
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- 預設公司不能是停用狀態（要停用請先把預設改到其他公司）。
DO $$ BEGIN
  ALTER TABLE public.companies ADD CONSTRAINT companies_default_active_chk CHECK (is_active OR NOT is_default);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
