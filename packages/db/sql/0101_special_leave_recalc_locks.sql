-- 2026-11-17 特殊假日重算互斥鎖（本檔 ＝ migrations/0111；接 sql/0100）。
--
-- 特殊假日新增／修改／刪除會重跑整月結算與草稿月表；同一租戶同時兩個請求會互相覆寫。
-- API（routes/special-leave-days.ts）寫入前先 INSERT 一列（tenant_id 唯一）取得鎖，做完 DELETE；
-- 撞唯一鍵＝重算進行中 → 409 recalc_in_progress。超過 10 分鐘的殘留鎖（程序中斷）可被下一個請求接手。
-- 只由 API（service role）存取：RLS 開、不給 policy、revoke anon／authenticated。純新增、可重跑；不動任何既有資料列。

CREATE TABLE IF NOT EXISTS public.special_leave_recalc_locks (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id),
  token uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by_emp_id uuid REFERENCES public.employees(id)
);

ALTER TABLE public.special_leave_recalc_locks ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON TABLE public.special_leave_recalc_locks FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT ALL ON TABLE public.special_leave_recalc_locks TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
