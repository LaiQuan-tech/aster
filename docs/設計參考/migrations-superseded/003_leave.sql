-- 003_leave.sql — 請假與特休（週年制自動發放）
-- 亞斯特 ERP / 2026-08-25
--
-- 設計要點：
-- 1. 特休額度規則進表（leave_entitlement_rules），不寫死在程式。
--    勞基法 §38 是「最低標準」，公司可優於法定；寫死等於把公司綁在最低標準上。
-- 2. 餘額不存單一數字，改由 leave_balance_transactions 累加得出。
--    特休爭議時能還原「任一天當下的餘額是多少、由哪幾筆構成」。
-- 3. 請假單永不硬刪（軟刪），保存年限見公司政策，法務建議 5 年以上。

create table leave_types (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  name                  text not null,
  is_paid               boolean not null default true,
  pay_rate              numeric(4,2) not null default 1.00,   -- 普通病假 0.5
  deducts_from_balance  boolean not null default false,       -- 特休/補休 true
  annual_cap_days       numeric(6,2),        -- 年度上限，如普通病假 30 日
  requires_attachment   boolean not null default false,
  requires_boss_approval boolean not null default false,
  min_unit_hours        numeric(4,2) not null default 1,      -- 最小請假單位
  sort_order            int not null default 0,
  is_active             boolean not null default true
);

comment on table leave_types is
  '假別定義。法定假別（特休/病假/事假/婚喪/產假/生理假/陪產）為最低標準，'
  '公司優於法定的部分直接改這張表的數值即可，不動程式。';

-- 特休（或其他隨年資成長的假別）額度規則
create table leave_entitlement_rules (
  id                  uuid primary key default gen_random_uuid(),
  leave_type_id       uuid not null references leave_types(id),
  service_months_from int not null,      -- 年資下限（月），含
  service_months_to   int,               -- 年資上限（月），不含；null = 無上限
  granted_days        numeric(6,2) not null,
  extra_days_per_year numeric(6,2) not null default 0,  -- 滿 10 年後每年加給
  max_days            numeric(6,2),                     -- 加給上限（法定 30 日）
  effective_from      date not null,
  effective_to        date,
  notes               text
);

-- 員工的假別額度區間（週年制：以到職日為界）
create table leave_entitlements (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references employees(id),
  leave_type_id       uuid not null references leave_types(id),
  period_start        date not null,      -- 到職週年日
  period_end          date not null,
  calculation_basis   text not null default 'anniversary',  -- anniversary|calendar
  granted_hours       numeric(8,2) not null,
  carried_over_hours  numeric(8,2) not null default 0,      -- §38 未休得遞延 1 年
  expires_at          date,
  generated_at        timestamptz not null default now(),
  unique (employee_id, leave_type_id, period_start)
);

create table leave_requests (
  id              uuid primary key default gen_random_uuid(),
  request_no      text unique,
  employee_id     uuid not null references employees(id),
  leave_type_id   uuid not null references leave_types(id),
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  hours           numeric(8,2) not null check (hours > 0),
  reason          text,
  attachment_url  text,
  status          text not null default 'draft',
                  -- draft|submitted|approved|rejected|cancelled
  approver_id     uuid references employees(id),
  approved_at     timestamptz,
  reject_reason   text,
  cancelled_at    timestamptz,
  cancel_reason   text,
  deleted_at      timestamptz,          -- 軟刪；紀錄永久保存
  created_at      timestamptz not null default now(),
  constraint leave_time_order check (end_at > start_at)
);

create index idx_leave_req_emp on leave_requests(employee_id, start_at desc)
  where deleted_at is null;
create index idx_leave_req_pending on leave_requests(status, start_at)
  where status = 'submitted' and deleted_at is null;

-- ★ 餘額流水帳：所有增減都是一筆交易，餘額由 sum 得出
create table leave_balance_transactions (
  id                uuid primary key default gen_random_uuid(),
  entitlement_id    uuid not null references leave_entitlements(id),
  txn_type          text not null,
                    -- grant 發放 | deduct 請假扣除 | reverse 銷假回沖
                    -- carryover 遞延轉入 | expire 逾期失效 | payout 未休折現
  hours             numeric(8,2) not null,   -- 正=增加，負=減少
  leave_request_id  uuid references leave_requests(id),
  created_by        uuid references employees(id),
  created_at        timestamptz not null default now(),
  notes             text
);

create index idx_leave_txn_ent on leave_balance_transactions(entitlement_id);

-- 目前餘額（小時）
create or replace function leave_balance_hours(p_entitlement_id uuid)
returns numeric
language sql stable
as $$
  select coalesce(sum(hours), 0)
  from leave_balance_transactions
  where entitlement_id = p_entitlement_id;
$$;

-- 員工在某日的某假別可用餘額
create or replace function employee_leave_balance(
  p_employee_id uuid, p_leave_type_id uuid, p_on_date date
) returns numeric
language sql stable
as $$
  select coalesce(leave_balance_hours(e.id), 0)
  from leave_entitlements e
  where e.employee_id = p_employee_id
    and e.leave_type_id = p_leave_type_id
    and p_on_date between e.period_start and e.period_end
  limit 1;
$$;

-- ============================================================
-- 特休自動發放（週年制）
-- ============================================================

-- 依到職日與規則表，為某員工產生指定週年區間的特休額度。
-- 重複呼叫安全：已存在的區間不重複發放。
create or replace function grant_annual_leave(
  p_employee_id uuid,
  p_period_start date          -- 該次週年區間起日
) returns uuid
language plpgsql
as $$
declare
  v_hire_date     date;
  v_type_id       uuid;
  v_service_mon   int;
  v_rule          leave_entitlement_rules%rowtype;
  v_days          numeric(6,2);
  v_ent_id        uuid;
  v_period_end    date;
begin
  select hire_date into v_hire_date from employees where id = p_employee_id;
  if v_hire_date is null then
    raise exception '員工不存在或未設定到職日: %', p_employee_id;
  end if;

  select id into v_type_id from leave_types where code = 'annual';
  v_period_end := (p_period_start + interval '1 year - 1 day')::date;

  -- 該區間起日時的年資（月）
  v_service_mon := (extract(year from age(p_period_start, v_hire_date)) * 12
                  + extract(month from age(p_period_start, v_hire_date)))::int;

  select * into v_rule
  from leave_entitlement_rules
  where leave_type_id = v_type_id
    and service_months_from <= v_service_mon
    and (service_months_to is null or v_service_mon < service_months_to)
    and effective_from <= p_period_start
    and (effective_to is null or effective_to >= p_period_start)
  order by effective_from desc, service_months_from desc
  limit 1;

  if v_rule.id is null then
    return null;   -- 年資未達最低門檻（未滿 6 個月）
  end if;

  v_days := v_rule.granted_days;

  -- 滿 10 年後每滿一年加給一日，至上限為止（§38 I 第 6 款）
  if v_rule.extra_days_per_year > 0 then
    v_days := v_days + v_rule.extra_days_per_year
              * greatest(0, floor(v_service_mon / 12.0) - (v_rule.service_months_from / 12));
    if v_rule.max_days is not null then
      v_days := least(v_days, v_rule.max_days);
    end if;
  end if;

  insert into leave_entitlements (
    employee_id, leave_type_id, period_start, period_end,
    granted_hours, expires_at
  ) values (
    p_employee_id, v_type_id, p_period_start, v_period_end,
    v_days * 8,
    (v_period_end + interval '1 year')::date   -- 未休得遞延一年
  )
  on conflict (employee_id, leave_type_id, period_start) do nothing
  returning id into v_ent_id;

  if v_ent_id is null then
    return null;   -- 已發放過
  end if;

  insert into leave_balance_transactions (entitlement_id, txn_type, hours, notes)
  values (v_ent_id, 'grant', v_days * 8,
          format('年資 %s 個月，依規則發放 %s 日', v_service_mon, v_days));

  return v_ent_id;
end;
$$;

-- ============================================================
-- 請假核准 → 扣除餘額 → 回寫出勤
-- ============================================================

create or replace function approve_leave_request(
  p_request_id uuid, p_approver_id uuid
) returns void
language plpgsql
as $$
declare
  v_req     leave_requests%rowtype;
  v_type    leave_types%rowtype;
  v_ent_id  uuid;
  v_balance numeric;
  v_day     date;
begin
  select * into v_req from leave_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception '請假單不存在: %', p_request_id;
  end if;
  if v_req.status <> 'submitted' then
    raise exception '只有已送簽的請假單可核准，目前狀態: %', v_req.status;
  end if;

  select * into v_type from leave_types where id = v_req.leave_type_id;

  if v_type.deducts_from_balance then
    select id into v_ent_id
    from leave_entitlements
    where employee_id = v_req.employee_id
      and leave_type_id = v_req.leave_type_id
      and v_req.start_at::date between period_start and period_end;

    if v_ent_id is null then
      raise exception '找不到適用的假別額度區間，請先確認特休是否已發放';
    end if;

    v_balance := leave_balance_hours(v_ent_id);
    if v_balance < v_req.hours then
      raise exception '餘額不足：可用 % 小時，申請 % 小時', v_balance, v_req.hours;
    end if;

    insert into leave_balance_transactions (
      entitlement_id, txn_type, hours, leave_request_id, created_by
    ) values (
      v_ent_id, 'deduct', -v_req.hours, p_request_id, p_approver_id
    );
  end if;

  update leave_requests
     set status = 'approved', approver_id = p_approver_id, approved_at = now()
   where id = p_request_id;

  -- 回寫每日彙總的請假時數（未鎖定的日期才動）
  for v_day in
    select generate_series(v_req.start_at::date, v_req.end_at::date, '1 day')::date
  loop
    insert into attendance_daily_summary (employee_id, work_date, day_type, leave_minutes)
    values (v_req.employee_id, v_day, 'workday', 0)
    on conflict (employee_id, work_date) do nothing;

    update attendance_daily_summary
       set leave_minutes = leave_minutes + (v_req.hours * 60 /
             greatest(1, (v_req.end_at::date - v_req.start_at::date + 1)))::int
     where employee_id = v_req.employee_id
       and work_date = v_day
       and not is_locked;
  end loop;
end;
$$;

-- 銷假：回沖餘額，原交易保留
create or replace function cancel_leave_request(
  p_request_id uuid, p_operator_id uuid, p_reason text
) returns void
language plpgsql
as $$
declare
  v_req leave_requests%rowtype;
  v_txn leave_balance_transactions%rowtype;
begin
  select * into v_req from leave_requests where id = p_request_id for update;
  if v_req.status <> 'approved' then
    raise exception '只有已核准的請假單需要銷假，目前狀態: %', v_req.status;
  end if;

  for v_txn in
    select * from leave_balance_transactions
    where leave_request_id = p_request_id and txn_type = 'deduct'
  loop
    insert into leave_balance_transactions (
      entitlement_id, txn_type, hours, leave_request_id, created_by, notes
    ) values (
      v_txn.entitlement_id, 'reverse', -v_txn.hours, p_request_id, p_operator_id,
      coalesce(p_reason, '銷假回沖')
    );
  end loop;

  update leave_requests
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where id = p_request_id;
end;
$$;
