-- 2026-10-10 通用選項清單（管理員可增修的分類字典）。第一個清單：客戶分類 client_category。
-- 前提：已套到 0057（sql/0047）。可重跑。
-- 資料列存 code（既有英文碼 architect 等原樣沿用，舊資料不改寫），畫面顯示 label；
-- 用過的選項只能停用，沒被引用的才可刪（API 依清單登記的引用欄位計數判斷）。
CREATE TABLE IF NOT EXISTS public.option_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  list_key text NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS option_items_tenant_list_code_uq ON public.option_items (tenant_id, list_key, code);
CREATE UNIQUE INDEX IF NOT EXISTS option_items_tenant_list_label_uq ON public.option_items (tenant_id, list_key, label);
CREATE INDEX IF NOT EXISTS option_items_tenant_list_idx ON public.option_items (tenant_id, list_key, sort_order);

-- API 走 service role；RLS 開啟但不給 policy＝前端直連一律擋。
ALTER TABLE public.option_items ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.option_items;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.option_items
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- 既有租戶種入客戶分類預設五項（與原本寫死的值、標籤相同）；新租戶由 API 首次讀取時補種。
INSERT INTO public.option_items (tenant_id, list_key, code, label, sort_order)
SELECT t.id, 'client_category', v.code, v.label, v.sort_order
FROM public.tenants t
CROSS JOIN (VALUES
  ('architect', '建築師', 10),
  ('engineer', '技師', 20),
  ('owner', '業主', 30),
  ('gov', '政府機關', 40),
  ('other', '其他', 50)
) AS v(code, label, sort_order)
ON CONFLICT (tenant_id, list_key, code) DO NOTHING;

-- 客戶分類改由 API 依 option_items 驗證，拿掉寫死的 CHECK。
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_category_chk;
