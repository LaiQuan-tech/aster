-- ═══════════════════════════════════════════════════════════════════════════
-- 套用：舊「下包工程」副委託改為不代扣 — 2026-11-15（業主決定）
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 先跑「預覽-2026-11-15-下包工程改不代扣.sql」確認「A 本次會改」的筆數與金額，再跑本檔。
-- ⚠️ 由業主本人在 Supabase Dashboard → SQL Editor 貼上整份執行；AI 不執行本檔。
--
-- 只改符合以下全部條件的列（＝預覽的「A 本次會改」）：
--   • 租戶 0507ad78-27f4-480e-b99f-a72db2aee50c、kind = 'subcontract'（下包工程）
--   • 副委託未軟刪除、所屬專案未軟刪除（觸發器 assert_project_not_deleted 的 PD409／RD409 不會被觸發）
--   • 代扣率 ≠ 0，或還有未付期別存著代扣金額
--   • 沒有任何一期已付款（paid_on／paid_amount）、已驗收（accepted_on）、排入非作廢放款單，也沒有代扣日期
-- 改什麼：
--   1. project_subcontract_payments：該副委託未付期別 withheld_amount → 0（＝系統 recomputePayments 在代扣率 0 時的結果；
--      期款 amount 與代扣率無關，不動）
--   2. project_subcontracts：withholding_rate → 0（withholding_threshold 保留，不影響計算）
-- 可重跑：第二次執行時已沒有符合條件的列，兩個 UPDATE 都是 0 列。
-- 稽核：audit_all 觸發器會把每筆變更寫進 audit_logs，context 標記為下方 x-actor-route。
-- 任何檢查失敗都會 RAISE，整個交易回滾（COMMIT 會變成 ROLLBACK），資料不會改到一半。
-- ═══════════════════════════════════════════════════════════════════════════
begin;

set local request.headers = '{"x-actor-route":"sql:2026-11-15 下包工程改不代扣"}';

drop table if exists _sub_nowh_target;
drop table if exists _sub_nowh_log;
create temp table _sub_nowh_log (step text, n int);

-- 目標副委託（先鎖住列，避免執行中同時有人改）
create temp table _sub_nowh_target as
select s.id, s.withholding_rate as old_rate
  from public.project_subcontracts s
  join public.projects p on p.id = s.project_id and p.tenant_id = s.tenant_id
 where s.tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'::uuid
   and s.kind = 'subcontract'
   and s.deleted_at is null
   and p.deleted_at is null
   and s.withholding_date is null
   and (s.withholding_rate <> 0
        or exists (select 1 from public.project_subcontract_payments sp
                    where sp.subcontract_id = s.id and sp.paid_on is null and sp.withheld_amount <> 0))
   and not exists (
         select 1 from public.project_subcontract_payments sp
          where sp.subcontract_id = s.id
            and (sp.paid_on is not null or sp.paid_amount is not null or sp.accepted_on is not null
                 or exists (select 1 from public.disbursements d
                             where d.id = sp.disbursement_id and d.status <> 'void')
                 or exists (select 1 from public.disbursement_allocations a
                              join public.disbursements d on d.id = a.disbursement_id
                             where a.subcontract_payment_id = sp.id and d.status <> 'void')))
   and not exists (
         select 1 from public.disbursement_allocations a
           join public.disbursements d on d.id = a.disbursement_id
          where a.subcontract_id = s.id and d.status <> 'void')
   for update of s;

insert into _sub_nowh_log select '目標副委託', count(*) from _sub_nowh_target;

-- 1. 期款：未付期別代扣金額歸 0
with u as (
  update public.project_subcontract_payments sp
     set withheld_amount = 0, updated_at = now()
    from _sub_nowh_target t
   where sp.subcontract_id = t.id
     and sp.tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'::uuid
     and sp.paid_on is null
     and sp.paid_amount is null
     and sp.withheld_amount <> 0
  returning sp.id
)
insert into _sub_nowh_log select '期款 withheld_amount→0', count(*) from u;

-- 2. 副委託：代扣率歸 0
with u as (
  update public.project_subcontracts s
     set withholding_rate = 0, updated_at = now()
    from _sub_nowh_target t
   where s.id = t.id
     and s.tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'::uuid
     and s.deleted_at is null
     and s.withholding_rate <> 0
  returning s.id
)
insert into _sub_nowh_log select '副委託 withholding_rate→0', count(*) from u;

-- 3. 驗證：目標副委託必須全部是 0% 且未付期別代扣為 0；本次不得碰到已付款／已刪除的列
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from _sub_nowh_target t
    join public.project_subcontracts s on s.id = t.id
   where s.withholding_rate <> 0
      or exists (select 1 from public.project_subcontract_payments sp
                  where sp.subcontract_id = s.id and sp.paid_on is null and sp.withheld_amount <> 0);
  if v_bad > 0 then
    raise exception '驗證失敗：仍有 % 筆目標副委託未歸零，整筆回滾', v_bad;
  end if;

  select count(*) into v_bad
    from _sub_nowh_target t
    join public.project_subcontracts s on s.id = t.id
    join public.projects p on p.id = s.project_id
   where s.deleted_at is not null or p.deleted_at is not null;
  if v_bad > 0 then
    raise exception '驗證失敗：目標含已刪除的列（%），整筆回滾', v_bad;
  end if;
end $$;

-- 驗證結果（交易內）
select step as "步驟", n as "筆數" from _sub_nowh_log
union all
select '剩餘：活的下包工程仍代扣≠0（含不在範圍者）', count(*)::int
  from public.project_subcontracts s
  join public.projects p on p.id = s.project_id
 where s.tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'::uuid
   and s.kind = 'subcontract' and s.deleted_at is null and p.deleted_at is null
   and s.withholding_rate <> 0;

commit;

-- COMMIT 後再顯示一次（SQL Editor 只顯示最後一個查詢的結果）
select step as "步驟", n as "筆數" from _sub_nowh_log
union all
select '剩餘：活的下包工程仍代扣≠0（含不在範圍者，需人工處理）', count(*)::int
  from public.project_subcontracts s
  join public.projects p on p.id = s.project_id
 where s.tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'::uuid
   and s.kind = 'subcontract' and s.deleted_at is null and p.deleted_at is null
   and s.withholding_rate <> 0;
