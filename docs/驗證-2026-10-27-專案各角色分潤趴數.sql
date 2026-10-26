-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-27-專案各角色分潤趴數.sql ＝ migration 0075 ＝ sql/0065）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-27-專案各角色分潤趴數.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- =====================================================================

-- ── 1. 新欄位在、可空、型別 jsonb ─────────────────────────────────────
-- 預期 1 row：share_pct_by_role jsonb YES
select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'share_pct_by_role';

-- ── 2. 形狀 CHECK ────────────────────────────────────────────────────
-- 預期 1 row：projects_share_pct_by_role_chk，定義含 jsonb_typeof(share_pct_by_role) = 'object'
select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.projects'::regclass and conname = 'projects_share_pct_by_role_chk';

-- ── 3. backfill 結果：每個租戶「已設定／未設定」的專案數，與租戶起始值並列 ─────
-- 預期：租戶起始值有非 0 值者，該租戶既有專案全部 has_setting=true；全 0／空者全部 false
select p.tenant_id, ps.default_share_pct_by_role as tenant_default, (p.share_pct_by_role is not null) as has_setting, count(*) from public.projects p left join public.project_settings ps on ps.tenant_id = p.tenant_id group by p.tenant_id, ps.default_share_pct_by_role, (p.share_pct_by_role is not null) order by p.tenant_id, has_setting;

-- ── 4. 已設定的專案與租戶起始值一致（套用當下）─────────────────────────
-- 預期 0 rows（剛套完時；之後老闆個別調整就會有差異，屬正常）
select p.id, p.code, p.share_pct_by_role, ps.default_share_pct_by_role from public.projects p join public.project_settings ps on ps.tenant_id = p.tenant_id where p.share_pct_by_role is not null and p.share_pct_by_role <> ps.default_share_pct_by_role;

-- ── 5. 建案函式已寫入新欄位、權限未放寬 ──────────────────────────────
-- 預期 1 row：writes_share=true；anon_exec=false；service_exec=true
select position('share_pct_by_role' in pg_get_functiondef(p.oid)) > 0 as writes_share, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec, has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_project_application_atomic';

-- ── 6. projects 沒有新增直接寫入 policy（寫入一律經 API）─────────────────
-- 預期：與套用前相同的 policy 清單（本檔不動 policy）
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'projects' order by policyname;
