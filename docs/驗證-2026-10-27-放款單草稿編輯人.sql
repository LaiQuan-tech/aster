set transaction read only;
-- =====================================================================
-- 放款單草稿編輯人（docs/套用-2026-10-27-放款單草稿編輯人.sql ＝ migration 0080 ＝ sql/0070）。
-- 全部唯讀。套用後跑。
-- （在 SQL editor 裡若 `set transaction read only` 需要交易，整份包 begin; … rollback; 執行。）
-- =====================================================================

-- ── 1. 欄位在、型別 uuid[]、NOT NULL、預設空陣列 ────────────────────
-- 預期 1 row：edited_by_emp_ids | ARRAY | _uuid | NO | '{}'::uuid[]
select column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'disbursements' and column_name = 'edited_by_emp_ids';

-- ── 2. 沒有 null（預期 0）───────────────────────────────────────────
select count(*) as null_rows from public.disbursements where edited_by_emp_ids is null;

-- ── 3. 已有編輯紀錄的單（套用後有人 PATCH 才會出現；僅供觀察）────────
select id, disbursement_no, status, created_by_emp_id, submitted_by_emp_id, edited_by_emp_ids
from public.disbursements
where cardinality(edited_by_emp_ids) > 0
order by updated_at desc
limit 20;
