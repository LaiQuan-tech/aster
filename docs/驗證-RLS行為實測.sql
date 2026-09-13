-- =====================================================================
-- RLS 行為實測（帳本待辦 #4：「RLS 只在 pglite 以 owner 身分驗過，等於未驗」）
--
-- 做法：以 postgres 連線（Supabase 的 postgres 有 bypassrls，但它是 anon/authenticated
-- 的成員，可以 SET LOCAL ROLE 變成它們），假造 JWT claims 給 auth.uid()/auth.jwt() 讀，
-- 在**一個最後 ROLLBACK 的交易**裡種兩個租戶的資料來測。什麼都不會留下。
--
-- 每個案例都寫死預期值，結果自動判 ✅/❌。跑法：
--   npm run db:apply -- docs/驗證-RLS行為實測.sql
-- （SQL Editor 也能整檔貼，它只顯示最後一條——最後一條就是結果表。）
--
-- 威脅模型：前端不直接讀表（apps/web 沒有 .from()），全部經 API 的 service_role。
-- RLS 擋的是「拿前端 bundle 裡的 anon key + 自己的 JWT 直接打 PostgREST」。
-- =====================================================================
begin;

create temp table _rls (no serial, test text, result text);

-- ── 種資料（postgres，bypass RLS）────────────────────────────────────
-- 租戶 status='test'：禁刪 trigger 對 test/demo 租戶放行（反正會 rollback）
insert into public.tenants (id, name, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'RLS測試A', 'test'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'RLS測試B', 'test');
insert into public.employees (id, tenant_id, user_id, name, role) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'HR-A',  'hr_admin'),
  ('aaaaaaaa-0000-4000-8000-0000000000e2', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000f2', '員工A', 'employee'),
  ('bbbbbbbb-0000-4000-8000-0000000000e1', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000f1', '員工B', 'employee');
insert into public.punch_records (tenant_id, employee_id, type) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e1', 'in'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e2', 'in'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000e1', 'in');
insert into public.payslips (tenant_id, employee_id, period) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e1', '2026-08'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e2', '2026-08'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000e1', '2026-08');
insert into public.salary_structures (tenant_id, employee_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e1'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000e2'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000e1');
insert into public.projects (id, tenant_id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', '專案A'),
  ('bbbbbbbb-0000-4000-8000-0000000000a1', 'bbbbbbbb-0000-4000-8000-000000000001', '專案B');
insert into public.contracts (tenant_id, project_id, doc_type, our_role, title) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'contract', 'contractor', '合約A'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000a1', 'contract', 'contractor', '合約B');
insert into public.announcements (tenant_id, title, body) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '公告A', 'x'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '公告B', 'x');

-- ── 以某個身分執行一條回傳單一 text 的 SQL，與預期比對 ─────────────────
-- p_role：'anon' 或 'authenticated'；p_claims：假 JWT（null = 沒登入）
-- p_expect：預期字串；預期要出錯時寫 'ERR:<sqlstate>'（例 ERR:42501 = RLS 擋下）
-- 每次都在子交易裡跑：出錯時自動回滾，role 與 claims 也跟著還原。
create function pg_temp.as_user(p_role text, p_claims jsonb, p_test text, p_sql text, p_expect text)
returns void language plpgsql as $$
declare v_actual text;
begin
  begin
    perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
    execute format('set local role %I', p_role);
    execute p_sql into v_actual;
    reset role;
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    v_actual := 'ERR:' || sqlstate;
  end;
  insert into _rls (test, result)
  values (p_test, case when v_actual = p_expect then '✅ ' else '❌ ' end || v_actual || '（預期 ' || p_expect || '）');
end $$;

-- 身分
-- anon：沒 JWT
-- empA：租戶 A 的一般員工；hrA：租戶 A 的 HR；empB：租戶 B 的一般員工
-- claims 形狀比照 Supabase：sub = auth.users.id，app_metadata.tenant_id 由後端寫入
select pg_temp.as_user('anon', null, 'anon 讀 tenants',   'select count(*)::text from public.tenants', '0');
-- employees / payslips 的 policy 會呼叫 is_hr_admin()，而 sql/0016 依 Supabase advisor 收回了
-- anon 對 SECURITY DEFINER 輔助函式的 EXECUTE → 沒登入直接 42501（比回空表更嚴，fail closed）
select pg_temp.as_user('anon', null, 'anon 讀 employees → 42501（policy 用到 is_hr_admin，anon 不可執行）', 'select count(*)::text from public.employees', 'ERR:42501');
select pg_temp.as_user('anon', null, 'anon 讀 payslips → 42501（同上）',  'select count(*)::text from public.payslips', 'ERR:42501');
select pg_temp.as_user('anon', null, 'anon 讀 contracts', 'select count(*)::text from public.contracts', '0');
select pg_temp.as_user('anon', null, 'anon 讀 audit_logs','select count(*)::text from public.audit_logs', '0');

-- 員工 A（authenticated，租戶 A）
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 employees → 只有自己', 'select string_agg(name, '','' order by name) from public.employees', '員工A');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 payslips → 只有自己那張', 'select count(*)::text from public.payslips', '1');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 salary_structures → 只有自己', 'select count(*)::text from public.salary_structures', '1');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 punch_records → 只有自己', 'select count(*)::text from public.punch_records', '1');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 projects → 本租戶全部、沒有 B 的', 'select string_agg(name, '','' order by name) from public.projects', '專案A');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 announcements → 本租戶', 'select string_agg(title, '','' order by title) from public.announcements', '公告A');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 contracts → 全擋（API 專用表，sql/0024）', 'select count(*)::text from public.contracts', '0');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 tenants → 全擋', 'select count(*)::text from public.tenants', '0');
-- 跨租戶寫
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A update 租戶 B 的 payslips → 0 列', 'with u as (update public.payslips set period = period where tenant_id = ''bbbbbbbb-0000-4000-8000-000000000001'' returning 1) select count(*)::text from u', '0');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A delete 租戶 B 的 projects → 0 列', 'with d as (delete from public.projects where tenant_id = ''bbbbbbbb-0000-4000-8000-000000000001'' returning 1) select count(*)::text from d', '0');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A insert 租戶 B 的 projects → RLS 擋下', 'insert into public.projects (tenant_id, name) values (''bbbbbbbb-0000-4000-8000-000000000001'', ''偷塞'') returning ''inserted''', 'ERR:42501');
-- 同租戶越權寫
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 改自己的 payslips → 擋下（只有 HR 能寫）', 'with u as (update public.payslips set period = period where employee_id = ''aaaaaaaa-0000-4000-8000-0000000000e2'' returning 1) select count(*)::text from u', '0');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 讀 HR-A 的 salary_structures → 0', 'select count(*)::text from public.salary_structures where employee_id = ''aaaaaaaa-0000-4000-8000-0000000000e1''', '0');
-- 允許的自助寫
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 幫自己打卡 → 允許', 'insert into public.punch_records (tenant_id, employee_id, type) values (''aaaaaaaa-0000-4000-8000-000000000001'', ''aaaaaaaa-0000-4000-8000-0000000000e2'', ''out'') returning ''inserted''', 'inserted');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  '員工A 幫 HR-A 打卡 → 擋下', 'insert into public.punch_records (tenant_id, employee_id, type) values (''aaaaaaaa-0000-4000-8000-000000000001'', ''aaaaaaaa-0000-4000-8000-0000000000e1'', ''out'') returning ''inserted''', 'ERR:42501');

-- HR A
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  'HR-A 讀 payslips → 本租戶 2 張、沒有 B 的', 'select count(*)::text from public.payslips', '2');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  'HR-A 讀 employees → 本租戶 2 人', 'select count(*)::text from public.employees', '2');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  'HR-A update 本租戶 payslips → 2 列（稽核 trigger 是 SECURITY DEFINER，寫 audit_logs 不被 RLS 擋）', 'with u as (update public.payslips set period = period where tenant_id = ''aaaaaaaa-0000-4000-8000-000000000001'' returning 1) select count(*)::text from u', '2');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  'HR-A update 租戶 B 的 payslips → 0 列', 'with u as (update public.payslips set period = period where tenant_id = ''bbbbbbbb-0000-4000-8000-000000000001'' returning 1) select count(*)::text from u', '0');
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f1","role":"authenticated","app_metadata":{"tenant_id":"aaaaaaaa-0000-4000-8000-000000000001"}}',
  'HR-A 讀 contracts → 仍全擋（API 專用表）', 'select count(*)::text from public.contracts', '0');

-- 員工 B 反向確認
select pg_temp.as_user('authenticated', '{"sub":"bbbbbbbb-0000-4000-8000-0000000000f1","role":"authenticated","app_metadata":{"tenant_id":"bbbbbbbb-0000-4000-8000-000000000001"}}',
  '員工B 讀 projects → 只有 B 的', 'select string_agg(name, '','' order by name) from public.projects', '專案B');

-- JWT 沒帶 tenant_id（後端沒寫 app_metadata 的帳號）→ 什麼都看不到
select pg_temp.as_user('authenticated', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000f2","role":"authenticated"}',
  '登入但 JWT 無 tenant_id → 讀 projects 0', 'select count(*)::text from public.projects', '0');

-- ── 結果 ──────────────────────────────────────────────────────────────
select no, test, result from _rls order by no;

rollback;
