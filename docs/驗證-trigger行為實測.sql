-- =====================================================================
-- Trigger 行為實測（結構已確認，這裡驗的是「真的有作用」）
--
-- 帳本待辦 #4 記著：「RLS policy 只在 pglite 以 owner 身分驗過，等於未驗」。
-- 結構在 ≠ 行為對。這兩段是讓本次的 trigger 不重蹈覆轍。
--
-- ⚠️ Supabase SQL Editor **一次執行只顯示最後一條語句的結果**，
--    且 RAISE NOTICE 不一定看得到。故兩段都設計成**回傳表格**，
--    並請**分開執行**（一次貼一段）。
-- =====================================================================


-- ── 實測 C：禁刪 trigger 對高權限身分是否真的有效 ────────────────────
--
-- SQL Editor 以高權限身分執行。**如果連這裡都刪不掉，API 的 service_role
-- 更刪不掉** —— 這是唯一能證明「應用層擋不住、DB 層擋得住」的測試。
--
-- 不會真的刪到資料：成功路徑強制丟例外，PL/pgSQL 的 EXCEPTION 區塊會把
-- 該子交易整個回滾。
--
-- 一次測四張表，每張回一列。
create or replace function public._probe_delete_guard(p_table text)
returns text
language plpgsql
as $$
declare
  v_id uuid;
begin
  execute format(
    'select x.id from public.%I x '
    'join public.tenants t on t.id = x.tenant_id '
    'where t.status = ''active'' limit 1', p_table)
  into v_id;

  if v_id is null then
    return p_table || '：略過（找不到正式租戶的資料可測）';
  end if;

  begin
    execute format('delete from public.%I where id = $1', p_table) using v_id;
    raise exception 'DELETE_SUCCEEDED';
  exception
    when sqlstate '23001' then
      return p_table || '：✅ 通過 — trigger 擋下了刪除';
    when others then
      if sqlerrm = 'DELETE_SUCCEEDED' then
        return p_table || '：❌ 失敗 — 刪除成功了（已回滾），trigger 沒生效';
      end if;
      return p_table || '：⚠️ ' || sqlerrm || ' (' || sqlstate || ')';
  end;
end $$;

select public._probe_delete_guard(t) as "禁刪 trigger 實測"
  from unnest(array[
    'punch_records',      -- 出勤紀錄（勞基法 §30 V，5 年）
    'leave_requests',     -- 請假單據（模組二第 2 條的主角）
    'announcements',      -- 公告規章
    'payslips'            -- 工資清冊（§23 II，5 年）
  ]) as t;

-- 跑完清掉探針：
--   drop function public._probe_delete_guard(text);


-- ── 實測 D：稽核 trigger 是否真的在寫 ────────────────────────────────
--
-- 值不變的 update（version = version）：rule_configs 內容完全不受影響，
-- 純粹為了觸發稽核。留下的那一列本身就是稽核有生效的證據。
update public.rule_configs set version = version
 where id = (select id from public.rule_configs limit 1);

select table_name, action, db_user, at
  from public.audit_logs
 order by at desc
 limit 5;
