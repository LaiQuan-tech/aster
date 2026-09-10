-- 008_audit_rls.sql — 稽核軌跡與資料列權限
-- 亞斯特 ERP / 2026-08-25
--
-- 權限分層：
--   1  一般員工：僅自己的出勤、請假、薪資條
--   2  經理：+ 直屬團隊（依 reports_to 遞迴）的出勤與請假，不含薪資與獎金
--   3  會計：+ 全員薪資、外包給付；獎金「金額」可見（要匯款），
--            「分配趴數與計算依據」不可見
--   4  老闆：全部，含獎金分配矩陣與稽核紀錄
--
-- 為何會計看得到獎金金額卻看不到趴數：匯款需要金額，但不需要知道
-- 「經理拿 40%、主辦拿 35%」這個計算基礎。原規劃寫「會計看不到獎金」，
-- 實作上會卡死出納作業。

-- ============================================================
-- 稽核軌跡
-- ============================================================

create table audit_logs (
  id            bigserial primary key,
  table_name    text not null,
  record_id     uuid,
  action        text not null,      -- insert|update|delete|export
  changed_by    uuid,
  changed_at    timestamptz not null default now(),
  old_value     jsonb,
  new_value     jsonb,
  changed_fields text[]             -- 只列真正變動的欄位，方便閱讀
);

create index idx_audit_table_record on audit_logs(table_name, record_id, changed_at desc);
create index idx_audit_changed_by on audit_logs(changed_by, changed_at desc);
create index idx_audit_changed_at on audit_logs(changed_at desc);

create table export_logs (
  id            bigserial primary key,
  exported_by   uuid references employees(id),
  scope         text not null,
  row_count     int,
  filters       jsonb,
  exported_at   timestamptz not null default now()
);

create or replace function audit_trigger_func()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
begin
  v_old := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) end;
  v_new := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) end;

  if TG_OP = 'UPDATE' then
    select array_agg(key) into v_changed
    from jsonb_each(v_new)
    where v_new -> key is distinct from v_old -> key;

    -- 只有 updated_at / calculated_at 變動不值得記一筆
    if v_changed is null or v_changed <@ array['updated_at','calculated_at'] then
      return NEW;
    end if;
  end if;

  insert into audit_logs
    (table_name, record_id, action, changed_by, old_value, new_value, changed_fields)
  values (
    TG_TABLE_NAME,
    case when TG_OP = 'DELETE' then (OLD.id)::uuid else (NEW.id)::uuid end,
    lower(TG_OP), current_employee_id(), v_old, v_new, v_changed
  );

  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

-- 掛上所有經手金額、工時、權限的表
do $$
declare t text;
begin
  foreach t in array array[
    'attendance_records', 'attendance_amendments', 'attendance_daily_summary',
    'leave_requests', 'leave_entitlements', 'leave_balance_transactions',
    'salary_profiles', 'payroll_periods', 'payroll_items',
    'contractor_payments', 'contractors',
    'bonus_batches', 'bonus_awards',
    'user_accounts', 'employees',
    'insurance_rates', 'insurance_grades', 'overtime_rates',
    'withholding_rules', 'system_parameters'
  ]
  loop
    execute format(
      'create trigger trg_audit_%1$s
         after insert or update or delete on %1$I
         for each row execute function audit_trigger_func()', t);
  end loop;
end;
$$;

-- attendance_daily_summary 的主鍵不是 id，audit trigger 取 NEW.id 會失敗，改用專用版本
drop trigger if exists trg_audit_attendance_daily_summary on attendance_daily_summary;

create or replace function audit_summary_trigger_func()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 彙總表由計算產生，只在「鎖定狀態改變」時值得留痕
  if TG_OP = 'UPDATE' and OLD.is_locked is distinct from NEW.is_locked then
    insert into audit_logs
      (table_name, record_id, action, changed_by, old_value, new_value, changed_fields)
    values ('attendance_daily_summary', null, 'update', current_employee_id(),
            to_jsonb(OLD), to_jsonb(NEW), array['is_locked']);
  end if;
  return NEW;
end;
$$;

create trigger trg_audit_summary_lock
  after update on attendance_daily_summary
  for each row execute function audit_summary_trigger_func();

-- ============================================================
-- 權限判斷 helper
-- ============================================================

-- 是否為我的直屬團隊（含各層部屬）
create or replace function is_in_my_team(p_employee_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  with recursive team as (
    select id from employees where id = current_employee_id()
    union all
    select e.id from employees e join team t on e.reports_to = t.id
  )
  select exists (select 1 from team where id = p_employee_id);
$$;

create or replace function is_self(p_employee_id uuid)
returns boolean language sql stable
as $$ select p_employee_id = current_employee_id(); $$;

create or replace function is_accounting()
returns boolean language sql stable
as $$ select current_permission_level() >= 3; $$;

create or replace function is_boss()
returns boolean language sql stable
as $$ select current_permission_level() >= 4; $$;

-- ============================================================
-- RLS
-- ============================================================

alter table employees                   enable row level security;
alter table attendance_records          enable row level security;
alter table attendance_amendments       enable row level security;
alter table attendance_daily_summary    enable row level security;
alter table leave_requests              enable row level security;
alter table leave_entitlements          enable row level security;
alter table leave_balance_transactions  enable row level security;
alter table salary_profiles             enable row level security;
alter table payroll_items               enable row level security;
alter table payroll_item_details        enable row level security;
alter table contractor_payments         enable row level security;
alter table contractors                 enable row level security;
alter table bonus_batches               enable row level security;
alter table bonus_awards                enable row level security;
alter table audit_logs                  enable row level security;
alter table export_logs                 enable row level security;

-- 員工基本資料：全員可見姓名部門（協作需要），敏感欄位交由 view 控制
create policy emp_read on employees for select
  using (current_permission_level() >= 1);
create policy emp_write on employees for all
  using (is_boss()) with check (is_boss());

-- 出勤：自己 / 團隊 / 會計以上
create policy att_read on attendance_records for select
  using (is_self(employee_id) or is_in_my_team(employee_id) or is_accounting());
create policy att_insert on attendance_records for insert
  with check (is_self(employee_id) or current_permission_level() >= 2);
create policy att_update on attendance_records for update
  using (current_permission_level() >= 2 or is_self(employee_id));

create policy amend_read on attendance_amendments for select
  using (is_self(employee_id) or is_in_my_team(employee_id) or is_accounting());
create policy amend_insert on attendance_amendments for insert
  with check (is_self(requested_by) or current_permission_level() >= 2);
create policy amend_approve on attendance_amendments for update
  using (current_permission_level() >= 2);

create policy summary_read on attendance_daily_summary for select
  using (is_self(employee_id) or is_in_my_team(employee_id) or is_accounting());

-- 請假
create policy leave_read on leave_requests for select
  using (is_self(employee_id) or is_in_my_team(employee_id) or is_accounting());
create policy leave_insert on leave_requests for insert
  with check (is_self(employee_id));
create policy leave_update on leave_requests for update
  using (is_self(employee_id) or is_in_my_team(employee_id));

create policy ent_read on leave_entitlements for select
  using (is_self(employee_id) or is_in_my_team(employee_id) or is_accounting());
create policy ent_write on leave_entitlements for all
  using (is_accounting()) with check (is_accounting());

create policy ltxn_read on leave_balance_transactions for select
  using (exists (
    select 1 from leave_entitlements e
    where e.id = entitlement_id
      and (is_self(e.employee_id) or is_in_my_team(e.employee_id) or is_accounting())));

-- 薪資：只有自己與會計以上，經理看不到部屬薪資
create policy salary_prof_read on salary_profiles for select
  using (is_self(employee_id) or is_accounting());
create policy salary_prof_write on salary_profiles for all
  using (is_accounting()) with check (is_accounting());

create policy payroll_read on payroll_items for select
  using (is_self(employee_id) or is_accounting());
create policy payroll_write on payroll_items for all
  using (is_accounting()) with check (is_accounting());

create policy payroll_detail_read on payroll_item_details for select
  using (exists (
    select 1 from payroll_items pi
    where pi.id = payroll_item_id
      and (is_self(pi.employee_id) or is_accounting())));

-- 外包：會計以上
create policy contractor_read on contractors for select using (is_accounting());
create policy contractor_write on contractors for all
  using (is_accounting()) with check (is_accounting());
create policy contractor_pay_read on contractor_payments for select using (is_accounting());
create policy contractor_pay_write on contractor_payments for all
  using (is_accounting()) with check (is_accounting());

-- 獎金：自己看自己的金額；會計看全部金額；只有老闆能寫
create policy bonus_award_read on bonus_awards for select
  using (is_self(employee_id) or is_accounting());
create policy bonus_award_write on bonus_awards for all
  using (is_boss()) with check (is_boss());

create policy bonus_batch_read on bonus_batches for select
  using (is_accounting());
create policy bonus_batch_write on bonus_batches for all
  using (is_boss()) with check (is_boss());

-- ★ 會計看得到獎金金額，但看不到分配趴數與計算依據。
--   欄位級遮蔽 PostgreSQL 原生不支援，故以 view 提供給前端，
--   前端一律查此 view 而非直接查表。
create view v_bonus_awards_for_accounting as
select
  ba.id, ba.batch_id, ba.employee_id, ba.status,
  ba.final_amount, ba.payroll_item_id, ba.paid_at,
  case when is_boss() then ba.allocation_percentage end as allocation_percentage,
  case when is_boss() then ba.calculated_amount end     as calculated_amount,
  case when is_boss() then ba.adjusted_amount end       as adjusted_amount,
  case when is_boss() then ba.adjustment_reason end     as adjustment_reason,
  case when is_boss() then ba.calculation_note end      as calculation_note,
  case when is_boss() then ba.role_in_batch end         as role_in_batch
from bonus_awards ba;

-- 稽核紀錄：只有老闆可讀，任何人不可改
create policy audit_read on audit_logs for select using (is_boss());
create policy export_read on export_logs for select using (is_boss());
create policy export_insert on export_logs for insert with check (true);

comment on table audit_logs is
  '稽核紀錄不設 update/delete policy——沒有任何角色可以修改或刪除，包含老闆。'
  '可被修改的稽核紀錄在爭議時沒有證明力。';
