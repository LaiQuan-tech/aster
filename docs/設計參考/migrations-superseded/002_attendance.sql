-- 002_attendance.sql — 出勤打卡（手機 GPS + 補登審核）
-- 亞斯特 ERP / 2026-08-25
--
-- 設計要點：
-- 1. attendance_records 是「實際發生什麼」的唯一真相，逐日一筆，永不硬刪。
--    任何修改都必須經 attendance_amendments 留下申請人、理由、審核人。
-- 2. 工時計算結果寫進 attendance_daily_summary 並可凍結：
--    薪資結算後規則若修法，歷史月份不得被重算成另一個數字。
-- 3. 承攬人員（contractors）不得進入本模組——出勤紀錄是僱傭關係的證據。

-- ============================================================
-- 行事曆與班別
-- ============================================================

create table work_calendar (
  id              uuid primary key default gen_random_uuid(),
  calendar_date   date not null,
  company_id      uuid references companies(id),   -- null = 全集團通用
  day_type        text not null,
                  -- workday 正常工作日 | rest_day 休息日(§24III 可加班)
                  -- regular_off 例假(§36 原則不得工作) | holiday 國定假日(§37)
  holiday_name    text,
  notes           text,
  constraint calendar_day_type_check
    check (day_type in ('workday','rest_day','regular_off','holiday'))
);

-- company_id 允許為 null（代表全集團通用），因此不能用 (calendar_date, company_id)
-- 當複合主鍵——PRIMARY KEY 隱含 NOT NULL，會讓「全集團設定」根本存不進去。
-- 改用兩個 partial unique index：公司專屬與全集團設定各自唯一。
create unique index uq_calendar_company on work_calendar(calendar_date, company_id)
  where company_id is not null;
create unique index uq_calendar_global on work_calendar(calendar_date)
  where company_id is null;
comment on table work_calendar is
  '每年須匯入內政部行政機關辦公日曆表並依公司實際出勤調整。缺行事曆會導致加班費算錯。';

create table work_shifts (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,              -- 「日班 08:30-17:30」
  start_time      time not null,
  end_time        time not null,
  break_minutes   int not null default 60,
  crosses_midnight boolean not null default false,
  is_default      boolean not null default false,
  is_active       boolean not null default true
);

create table employee_shifts (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references employees(id),
  shift_id        uuid not null references work_shifts(id),
  effective_from  date not null,
  effective_to    date,
  unique (employee_id, effective_from)
);

-- ============================================================
-- 工地／據點與地理圍欄
-- ============================================================

create table work_sites (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,              -- 「總公司」「XX 案工地」
  site_type       text not null default 'site',   -- office|site|client
  address         text,
  latitude        numeric(10,7),
  longitude       numeric(10,7),
  radius_meters   int not null default 200,   -- 圍欄半徑
  project_ref     text,                       -- 對應專案編號（專案模組上線後轉 FK）
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- 兩點距離（公尺）。用 Haversine 純數學，不依賴 PostGIS，方便日後搬離 Supabase。
create or replace function geo_distance_meters(
  lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric
) returns numeric
language sql immutable
as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians(lon2 - lon1) / 2), 2)
  ))::numeric;
$$;

-- ============================================================
-- 打卡紀錄
-- ============================================================

create table attendance_records (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references employees(id),
  work_date         date not null,
  clock_in          timestamptz,
  clock_out         timestamptz,
  shift_id          uuid references work_shifts(id),
  break_minutes     int not null default 60,
  work_mode         text not null default 'office',   -- office|remote|site

  -- 上班打卡的定位證據
  in_site_id        uuid references work_sites(id),
  in_latitude       numeric(10,7),
  in_longitude      numeric(10,7),
  in_accuracy_m     numeric(8,2),        -- 裝置回報精度；過大者不可信
  in_within_fence   boolean,             -- 是否落在圍欄內（寫入時計算並凍結）
  in_distance_m     numeric(10,2),
  in_device_id      text,                -- 裝置指紋：偵測一機多人代打

  -- 下班打卡的定位證據
  out_site_id       uuid references work_sites(id),
  out_latitude      numeric(10,7),
  out_longitude     numeric(10,7),
  out_accuracy_m    numeric(8,2),
  out_within_fence  boolean,
  out_distance_m    numeric(10,2),
  out_device_id     text,

  source            text not null default 'mobile',   -- mobile|web|proxy|import
  is_amended        boolean not null default false,
  anomaly_flags     text[] not null default '{}',
                    -- out_of_fence | low_accuracy | shared_device | missing_clock_out
                    -- | over_daily_limit | worked_on_regular_off
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_id, work_date)
);

comment on column attendance_records.anomaly_flags is
  '異常只標記、不阻擋打卡。擋下打卡會逼出更糟的因應（找同事代打、事後全靠補登），'
  '真實紀錄加上可查的旗標，比乾淨但失真的紀錄有用。';

create index idx_attendance_emp_date on attendance_records(employee_id, work_date desc);
create index idx_attendance_date on attendance_records(work_date desc);
create index idx_attendance_anomaly on attendance_records
  using gin(anomaly_flags) where anomaly_flags <> '{}';

-- ============================================================
-- 補登與代登（一律留痕）
-- ============================================================

create table attendance_amendments (
  id                  uuid primary key default gen_random_uuid(),
  attendance_record_id uuid references attendance_records(id),  -- null = 整日補登
  employee_id         uuid not null references employees(id),
  work_date           date not null,
  amendment_type      text not null,   -- add 補登 | modify 修改 | void 作廢

  -- 修改前後（before 於核准當下快照，之後不再變動）
  before_clock_in     timestamptz,
  before_clock_out    timestamptz,
  requested_clock_in  timestamptz,
  requested_clock_out timestamptz,
  requested_work_mode text,

  reason              text not null,   -- 必填，空字串不算理由
  evidence_url        text,            -- 出差單、外出證明

  requested_by        uuid not null references employees(id),
  requested_at        timestamptz not null default now(),
  is_proxy            boolean not null default false,   -- 主管代登
  status              text not null default 'pending',  -- pending|approved|rejected
  approved_by         uuid references employees(id),
  approved_at         timestamptz,
  reject_reason       text,

  constraint amendment_reason_not_blank check (length(btrim(reason)) >= 2),
  constraint amendment_type_check check (amendment_type in ('add','modify','void'))
);

create index idx_amendments_pending on attendance_amendments(status, work_date)
  where status = 'pending';
create index idx_amendments_emp on attendance_amendments(employee_id, work_date desc);

-- ============================================================
-- 每日工時計算
-- ============================================================

create table attendance_daily_summary (
  employee_id         uuid not null references employees(id),
  work_date           date not null,
  day_type            text not null,
  worked_minutes      int not null default 0,   -- 扣除休息後的實際工作時間
  regular_minutes     int not null default 0,   -- 正常工時（平日上限 8h）
  ot_tier1_minutes    int not null default 0,   -- 第 1-2 延長工時小時
  ot_tier2_minutes    int not null default 0,   -- 第 3-4 延長工時小時
  ot_tier3_minutes    int not null default 0,   -- 休息日第 9-12 小時
  holiday_minutes     int not null default 0,   -- 國定假日/例假出勤
  leave_minutes       int not null default 0,   -- 當日請假時數（由請假模組回寫）
  is_locked           boolean not null default false,   -- 薪資結算後凍結
  locked_at           timestamptz,
  calculated_at       timestamptz not null default now(),
  primary key (employee_id, work_date)
);

comment on column attendance_daily_summary.is_locked is
  '薪資核定後鎖定。法規參數日後調整時，歷史月份必須維持當時算出的數字，否則帳對不回去。';

-- 依打卡紀錄計算單日工時分段。回傳計算結果，由呼叫端決定是否寫入。
create or replace function calc_daily_work_minutes(
  p_employee_id uuid,
  p_work_date   date
) returns table (
  day_type text, worked_minutes int, regular_minutes int,
  ot_tier1_minutes int, ot_tier2_minutes int, ot_tier3_minutes int,
  holiday_minutes int, anomalies text[]
)
language plpgsql stable
as $$
declare
  v_rec        attendance_records%rowtype;
  v_day_type   text;
  v_company    uuid;
  v_worked     int := 0;
  v_ot         int := 0;
  v_anomalies  text[] := '{}';
begin
  select * into v_rec
  from attendance_records
  where employee_id = p_employee_id and work_date = p_work_date;

  select primary_company_id into v_company from employees where id = p_employee_id;

  -- 行事曆：優先取公司專屬，其次全集團通用，都沒有則預設為工作日
  select wc.day_type into v_day_type
  from work_calendar wc
  where wc.calendar_date = p_work_date
    and (wc.company_id = v_company or wc.company_id is null)
  order by wc.company_id nulls last
  limit 1;
  v_day_type := coalesce(v_day_type, 'workday');

  if v_rec.id is null or v_rec.clock_in is null then
    return query select v_day_type, 0, 0, 0, 0, 0, 0, v_anomalies;
    return;
  end if;

  if v_rec.clock_out is null then
    v_anomalies := array_append(v_anomalies, 'missing_clock_out');
    return query select v_day_type, 0, 0, 0, 0, 0, 0, v_anomalies;
    return;
  end if;

  v_worked := greatest(0,
    (extract(epoch from (v_rec.clock_out - v_rec.clock_in)) / 60)::int
    - coalesce(v_rec.break_minutes, 0));

  -- 單日工時上限 12 小時（勞基法 §32 II：正常 8 + 延長 4）
  if v_worked > 720 then
    v_anomalies := array_append(v_anomalies, 'over_daily_limit');
  end if;

  if v_day_type = 'workday' then
    -- 平日：正常 8h，延長分兩段各 2h
    v_ot := greatest(0, v_worked - 480);
    return query select
      v_day_type,
      v_worked,
      least(v_worked, 480),
      least(v_ot, 120),
      greatest(0, least(v_ot - 120, 120)),
      0,
      0,
      v_anomalies;

  elsif v_day_type = 'rest_day' then
    -- 休息日（§24 III）：全部算延長工時，前2h / 第3-8h / 第9-12h 三段
    return query select
      v_day_type,
      v_worked,
      0,
      least(v_worked, 120),
      greatest(0, least(v_worked - 120, 360)),
      greatest(0, least(v_worked - 480, 240)),
      0,
      v_anomalies;

  else
    -- 例假(§36) / 國定假日(§37)
    if v_day_type = 'regular_off' then
      -- 例假原則上不得使勞工工作，除天災事變。出現紀錄即為需要說明的事件。
      v_anomalies := array_append(v_anomalies, 'worked_on_regular_off');
    end if;
    return query select
      v_day_type, v_worked, 0, 0, 0, 0, v_worked, v_anomalies;
  end if;
end;
$$;

-- 重算並寫入單日彙總（已鎖定的日期不動）
create or replace function refresh_daily_summary(
  p_employee_id uuid, p_work_date date
) returns void
language plpgsql
as $$
declare r record;
begin
  if exists (select 1 from attendance_daily_summary
             where employee_id = p_employee_id
               and work_date = p_work_date and is_locked) then
    return;
  end if;

  select * into r from calc_daily_work_minutes(p_employee_id, p_work_date);

  insert into attendance_daily_summary as s (
    employee_id, work_date, day_type, worked_minutes, regular_minutes,
    ot_tier1_minutes, ot_tier2_minutes, ot_tier3_minutes, holiday_minutes,
    calculated_at
  ) values (
    p_employee_id, p_work_date, r.day_type, r.worked_minutes, r.regular_minutes,
    r.ot_tier1_minutes, r.ot_tier2_minutes, r.ot_tier3_minutes, r.holiday_minutes,
    now()
  )
  on conflict (employee_id, work_date) do update set
    day_type = excluded.day_type,
    worked_minutes = excluded.worked_minutes,
    regular_minutes = excluded.regular_minutes,
    ot_tier1_minutes = excluded.ot_tier1_minutes,
    ot_tier2_minutes = excluded.ot_tier2_minutes,
    ot_tier3_minutes = excluded.ot_tier3_minutes,
    holiday_minutes = excluded.holiday_minutes,
    calculated_at = now()
  where not s.is_locked;

  -- 異常旗標回寫。
  -- 定位類旗標（out_of_fence/low_accuracy/shared_device）於打卡當下判定，保留；
  -- 工時類旗標每次重算都重新產生，否則補登修正後舊旗標會殘留，變成永遠洗不掉的紅字。
  update attendance_records ar
     set anomaly_flags = (
           select coalesce(array_agg(distinct f), '{}')
           from unnest(
             array(select g from unnest(ar.anomaly_flags) g
                    where g in ('out_of_fence','low_accuracy','shared_device'))
             || r.anomalies
           ) as f
         ),
         updated_at = now()
   where ar.employee_id = p_employee_id and ar.work_date = p_work_date;
end;
$$;

-- trigger function 必須先於 trigger 建立
create or replace function trg_refresh_summary()
returns trigger language plpgsql as $$
begin
  perform refresh_daily_summary(new.employee_id, new.work_date);
  return new;
end;
$$;

-- 只監聽影響工時的欄位：函式內回寫 anomaly_flags 不會遞迴觸發
create trigger trg_attendance_refresh_summary
  after insert or update of clock_in, clock_out, break_minutes
  on attendance_records
  for each row
  execute function trg_refresh_summary();

-- ============================================================
-- 工時預警（取代鎖卡：提醒主管，不隱藏工時）
-- ============================================================

create table work_hour_alerts (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references employees(id),
  period_type       text not null,        -- week | month
  period_start      date not null,
  period_end        date not null,
  metric            text not null,        -- overtime_minutes | total_minutes
  threshold_minutes int not null,
  current_minutes   int not null,
  severity          text not null,        -- warning | critical
  alerted_at        timestamptz not null default now(),
  acknowledged_by   uuid references employees(id),
  acknowledged_at   timestamptz,
  action_taken      text,                 -- 主管處置：加派人力/轉補休/核准加班
  unique (employee_id, period_type, period_start, metric)
);

comment on table work_hour_alerts is
  '單月延長工時上限 46 小時（§32 II），經工會或勞資會議同意得採 3 個月 138 小時。'
  '門檻值進 system_parameters，因為各公司採用的制度不同。';
