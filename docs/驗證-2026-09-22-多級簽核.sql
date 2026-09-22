-- =====================================================================
-- 套用後驗證（涵蓋 docs/套用-2026-09-22-多級簽核.sql 的 [0]～[4]）
--
-- 用 `npm run db:apply -- docs/驗證-2026-09-22-多級簽核.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [0] 三個新欄位都在、型別正確 ───────────────────────────────────
-- 預期 3 rows：
--   approval_steps | candidate_emp_ids | ARRAY | uuid[] | YES | (null)
--   approval_steps | step_kind         | text  | text   | YES | (null)
--   departments    | manager_emp_ids   | ARRAY | uuid[] | NO  | '{}'::uuid[]
select table_name, column_name, data_type,
       udt_name as udt,
       is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (
     ('departments', 'manager_emp_ids'),
     ('approval_steps', 'candidate_emp_ids'),
     ('approval_steps', 'step_kind'))
 order by table_name, column_name;

-- ── 2. [1] approval_flows.mode CHECK 含 manager_hr ───────────────────
-- 預期 1 row：definition 內含 'manager', 'list', 'manager_hr'
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.approval_flows'::regclass
   and conname = 'approval_flows_mode_chk';

-- ── 3. [2] backfill 收斂：有 manager_emp_id 但陣列是空的列應為 0 ────────
-- 預期 1 row：unsynced = 0、mismatched_first = 0、total_with_manager = 目前設有主管的部門數
select
  count(*) filter (where manager_emp_id is not null and cardinality(manager_emp_ids) = 0) as unsynced,
  count(*) filter (where manager_emp_id is not null and cardinality(manager_emp_ids) > 0
                     and manager_emp_ids[1] is distinct from manager_emp_id)             as mismatched_first,
  count(*) filter (where manager_emp_id is not null)                                     as total_with_manager,
  count(*)                                                                               as total_departments
  from public.departments;

-- ── 4. [3] manages_project_dept() 已是新版（函式本體含 manager_emp_ids） ──
-- 預期 1 row：uses_manager_emp_ids = true、security_definer = true
select proname,
       prosrc like '%manager_emp_ids%' as uses_manager_emp_ids,
       prosecdef                        as security_definer
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname = 'manages_project_dept';

-- ── 5. [3] 函式 ACL：anon / authenticated / service_role 都可執行（同 sql/0015 第 91–95 行）──
-- 預期 1 row：anon_can = true、authenticated_can = true、service_role_can = true
-- （RLS policy 以查詢者角色求值，anon 沒有 EXECUTE 會報 permission denied 而不是回 false，
--  所以不收 anon；函式本身對未登入者只會回 false。）
select
  has_function_privilege('authenticated', 'public.manages_project_dept(uuid)', 'EXECUTE') as authenticated_can,
  has_function_privilege('service_role',  'public.manages_project_dept(uuid)', 'EXECUTE') as service_role_can,
  has_function_privilege('anon',          'public.manages_project_dept(uuid)', 'EXECUTE') as anon_can;

-- ── 6. [4] COMMENT 都在 ───────────────────────────────────────────────
-- 預期 3 rows，comment 皆非 null
select c.relname as table_name, a.attname as column_name,
       left(col_description(c.oid, a.attnum), 40) as comment_head
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
 where c.relnamespace = 'public'::regnamespace
   and (c.relname, a.attname) in (
     ('departments', 'manager_emp_ids'),
     ('approval_steps', 'candidate_emp_ids'),
     ('approval_steps', 'step_kind'))
 order by 1, 2;

-- ── 7. 交叉確認：既有 approval_steps 舊列 candidate_emp_ids 皆 null（尚無多候選單）──
-- 預期 1 row：套用當下 with_candidates = 0（之後有人送 manager_hr 單就會 >0）
select count(*) filter (where candidate_emp_ids is not null) as with_candidates,
       count(*) filter (where step_kind is not null)          as with_kind,
       count(*)                                               as total_steps
  from public.approval_steps;
