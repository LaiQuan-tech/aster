-- 2026-11-05 公務車管理：車輛主檔、保養紀錄、預約（簽核走 leave_requests kind='vehicle_booking'）、
-- 用車紀錄（取車／還車）、費用行（員工代墊 → expense_claims）、車況照片、提醒去重、模組設定。
-- 前提：已套到 0084（sql/0074）。可重跑（IF NOT EXISTS／duplicate_object／CREATE OR REPLACE）。
-- 全部只由 API（service role）存取：RLS 開、不給 policy；掛 audit_all。

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- 1. 車輛主檔
CREATE TABLE IF NOT EXISTS public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  plate_no text NOT NULL,                       -- 存大寫、去空白（API 正規化）
  model text NOT NULL,                          -- 車型（例：Toyota Corolla Altis）
  seats integer,
  status text NOT NULL DEFAULT 'available',     -- available 可用 / maintenance 維修中 / retired 停用
  current_odometer integer NOT NULL DEFAULT 0,  -- 目前里程（km），還車時取 max 更新
  maintenance_interval_km integer,              -- 每 N 公里保養（null＝不依里程）
  maintenance_interval_months integer,          -- 每 N 個月保養（null＝不依日期）
  last_maintenance_on date,
  last_maintenance_odometer integer,
  next_maintenance_on date,                     -- API 依 last + interval 計算後存（也可手改）
  next_maintenance_odometer integer,
  insurance_expires_on date,                    -- 保險到期
  license_tax_due_on date,                      -- 牌照稅繳納期限
  note text,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_tenant_plate_uidx ON public.vehicles (tenant_id, plate_no);
CREATE INDEX IF NOT EXISTS vehicles_tenant_status_idx ON public.vehicles (tenant_id, status);
DO $$ BEGIN
  ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_status_chk CHECK (status IN ('available','maintenance','retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_odometer_chk CHECK (current_odometer >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_intervals_chk
    CHECK ((maintenance_interval_km IS NULL OR maintenance_interval_km > 0)
       AND (maintenance_interval_months IS NULL OR maintenance_interval_months > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_plate_chk CHECK (char_length(btrim(plate_no)) BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. 保養紀錄（HR 登記「已保養」→ 更新 vehicles.last_*／next_*）
CREATE TABLE IF NOT EXISTS public.vehicle_maintenance_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
  serviced_on date NOT NULL,
  odometer integer NOT NULL,
  cost numeric(12,2),                -- 僅紀錄；公司付款不經報銷
  note text,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_maintenance_logs_vehicle_idx ON public.vehicle_maintenance_logs (tenant_id, vehicle_id, serviced_on DESC);

-- 3. 預約（簽核在 leave_requests；本表是時段的單一真相）
CREATE TABLE IF NOT EXISTS public.vehicle_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  request_id uuid REFERENCES public.leave_requests(id),   -- 建單流程中短暫為 null
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  purpose text NOT NULL,
  destination text,
  passengers integer,
  status text NOT NULL DEFAULT 'pending',   -- pending / approved / rejected / cancelled / completed
  cancel_reason text,
  cancelled_by_emp_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_bookings_request_uidx ON public.vehicle_bookings (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vehicle_bookings_vehicle_time_idx ON public.vehicle_bookings (tenant_id, vehicle_id, start_at);
CREATE INDEX IF NOT EXISTS vehicle_bookings_employee_idx ON public.vehicle_bookings (tenant_id, employee_id, start_at DESC);
DO $$ BEGIN
  ALTER TABLE public.vehicle_bookings ADD CONSTRAINT vehicle_bookings_status_chk
    CHECK (status IN ('pending','approved','rejected','cancelled','completed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_bookings ADD CONSTRAINT vehicle_bookings_range_chk CHECK (end_at > start_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_bookings ADD CONSTRAINT vehicle_bookings_purpose_chk CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 250);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 時段防重疊：同一台車、簽核中或已核准的預約不得重疊（半開區間 [start, end)，前一筆 10:00 結束、下一筆 10:00 開始可以）。
-- 併發兩人同時送單只有一筆成立（23P01 exclusion_violation → API 409 vehicle_booking_conflict）。
DO $$ BEGIN
  ALTER TABLE public.vehicle_bookings ADD CONSTRAINT vehicle_bookings_no_overlap
    EXCLUDE USING gist (vehicle_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
    WHERE (status IN ('pending','approved'));
-- exclusion constraint 會一併建索引：重跑時撞的是 42P07 duplicate_table（不是 duplicate_object）
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- 3b. 簽核結果 → 預約狀態（同交易；只動還在 pending 的預約）
CREATE OR REPLACE FUNCTION public.vehicle_booking_sync_from_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.vehicle_bookings b
     SET status = CASE
                    WHEN NEW.deleted_at IS NOT NULL THEN 'cancelled'
                    WHEN NEW.status = 'approved'  THEN 'approved'
                    WHEN NEW.status = 'rejected'  THEN 'rejected'
                    WHEN NEW.status = 'cancelled' THEN 'cancelled'
                    ELSE b.status
                  END,
         decided_at = CASE WHEN NEW.status IN ('approved','rejected') THEN now() ELSE b.decided_at END,
         updated_at = now()
   WHERE b.request_id = NEW.id
     AND b.status = 'pending'
     AND (NEW.deleted_at IS NOT NULL OR NEW.status IN ('approved','rejected','cancelled'));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS vehicle_booking_sync ON public.leave_requests;
CREATE TRIGGER vehicle_booking_sync
  AFTER UPDATE OF status, deleted_at ON public.leave_requests
  FOR EACH ROW WHEN (NEW.kind = 'vehicle_booking')
  EXECUTE FUNCTION public.vehicle_booking_sync_from_request();
REVOKE ALL ON FUNCTION public.vehicle_booking_sync_from_request() FROM PUBLIC, anon, authenticated;

-- 4. 用車紀錄（一筆預約最多一次取車；一台車同時最多一筆未還車）
CREATE TABLE IF NOT EXISTS public.vehicle_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
  booking_id uuid NOT NULL REFERENCES public.vehicle_bookings(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  checked_out_at timestamptz NOT NULL DEFAULT now(),
  start_odometer integer NOT NULL,
  odometer_override_reason text,          -- 出車里程 < 車輛目前里程時必填
  returned_at timestamptz,
  end_odometer integer,
  distance_km integer GENERATED ALWAYS AS (end_odometer - start_odometer) STORED,
  purpose text,                           -- 預設帶預約的用途，還車可修正
  destination text,
  condition_status text,                  -- ok / issue（還車時必填）
  condition_note text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_trips_booking_uidx ON public.vehicle_trips (booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_trips_open_per_vehicle_uidx ON public.vehicle_trips (vehicle_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS vehicle_trips_tenant_time_idx ON public.vehicle_trips (tenant_id, checked_out_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_trips_employee_idx ON public.vehicle_trips (tenant_id, employee_id, checked_out_at DESC);
DO $$ BEGIN
  ALTER TABLE public.vehicle_trips ADD CONSTRAINT vehicle_trips_odometer_chk
    CHECK (start_odometer >= 0 AND (end_odometer IS NULL OR end_odometer >= start_odometer));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_trips ADD CONSTRAINT vehicle_trips_return_chk
    CHECK ((returned_at IS NULL AND end_odometer IS NULL) OR (returned_at IS NOT NULL AND end_odometer IS NOT NULL AND condition_status IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_trips ADD CONSTRAINT vehicle_trips_condition_chk CHECK (condition_status IS NULL OR condition_status IN ('ok','issue'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5. 費用行（加油／過路費／停車費／其他）；員工代墊者可轉報銷
CREATE TABLE IF NOT EXISTS public.vehicle_trip_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  trip_id uuid NOT NULL REFERENCES public.vehicle_trips(id),
  cost_type text NOT NULL,                -- fuel / toll / parking / other
  amount numeric(12,2) NOT NULL,
  paid_by text NOT NULL,                  -- employee（員工代墊→可報銷）/ company（公司卡／ETC 月結，不報銷）
  incurred_on date NOT NULL,
  note text,
  claim_state text NOT NULL DEFAULT 'none',   -- none / creating / claimed（只對 paid_by=employee 有意義）
  expense_claim_id uuid REFERENCES public.expense_claims(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_trip_costs_trip_idx ON public.vehicle_trip_costs (tenant_id, trip_id);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_trip_costs_claim_uidx ON public.vehicle_trip_costs (expense_claim_id) WHERE expense_claim_id IS NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.vehicle_trip_costs ADD CONSTRAINT vehicle_trip_costs_type_chk CHECK (cost_type IN ('fuel','toll','parking','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_trip_costs ADD CONSTRAINT vehicle_trip_costs_paid_by_chk CHECK (paid_by IN ('employee','company'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_trip_costs ADD CONSTRAINT vehicle_trip_costs_amount_chk CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_trip_costs ADD CONSTRAINT vehicle_trip_costs_claim_chk
    CHECK (claim_state IN ('none','creating','claimed')
       AND (claim_state <> 'claimed' OR expense_claim_id IS NOT NULL)
       AND (paid_by = 'employee' OR claim_state = 'none'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. 車況照片（private bucket vehicle-photos）
CREATE TABLE IF NOT EXISTS public.vehicle_trip_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  trip_id uuid NOT NULL REFERENCES public.vehicle_trips(id),
  phase text NOT NULL,                    -- checkout / return
  file_name text NOT NULL,
  storage_path text NOT NULL,
  size_bytes integer NOT NULL,
  content_type text NOT NULL,
  content_hash text NOT NULL,
  uploaded_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_trip_photos_trip_idx ON public.vehicle_trip_photos (tenant_id, trip_id, created_at);
DO $$ BEGIN
  ALTER TABLE public.vehicle_trip_photos ADD CONSTRAINT vehicle_trip_photos_phase_chk CHECK (phase IN ('checkout','return'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7. 提醒去重（同一到期點只通知一次）
CREATE TABLE IF NOT EXISTS public.vehicle_reminder_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
  kind text NOT NULL,     -- maintenance_date / maintenance_odometer / insurance / license_tax / overdue_return
  due_key text NOT NULL,  -- 到期日 'YYYY-MM-DD'、里程 'km:123000'、逾期還車 'trip:<id>'
  notified_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_reminder_log_uidx ON public.vehicle_reminder_log (vehicle_id, kind, due_key);

-- 8. 模組設定（每租戶一列；比照 expense_settings）
CREATE TABLE IF NOT EXISTS public.vehicle_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id),
  fuel_category_id uuid REFERENCES public.expense_categories(id),
  toll_category_id uuid REFERENCES public.expense_categories(id),
  parking_category_id uuid REFERENCES public.expense_categories(id),
  other_category_id uuid REFERENCES public.expense_categories(id),
  reminder_lead_days integer NOT NULL DEFAULT 30,
  maintenance_lead_km integer NOT NULL DEFAULT 500,
  reminder_emp_ids uuid[] NOT NULL DEFAULT '{}',   -- 除了 hr_admin 以外也要收提醒的人（總務）
  max_booking_hours integer NOT NULL DEFAULT 72,
  checkout_early_minutes integer NOT NULL DEFAULT 60,
  max_days_ahead integer NOT NULL DEFAULT 90,       -- 最多可預約到幾天後
  updated_by_emp_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.vehicle_settings ADD CONSTRAINT vehicle_settings_ranges_chk
    CHECK (reminder_lead_days BETWEEN 1 AND 180 AND maintenance_lead_km BETWEEN 0 AND 10000
       AND max_booking_hours BETWEEN 1 AND 720 AND checkout_early_minutes BETWEEN 0 AND 1440);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vehicle_settings ADD CONSTRAINT vehicle_settings_days_ahead_chk CHECK (max_days_ahead BETWEEN 1 AND 365);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS（API only）＋ 稽核
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicles','vehicle_maintenance_logs','vehicle_bookings','vehicle_trips',
                           'vehicle_trip_costs','vehicle_trip_photos','vehicle_reminder_log','vehicle_settings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
  -- 稽核：提醒去重表高頻且無業務意義，不掛
  FOREACH t IN ARRAY ARRAY['vehicles','vehicle_maintenance_logs','vehicle_bookings','vehicle_trips',
                           'vehicle_trip_costs','vehicle_trip_photos','vehicle_settings'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t);
    EXECUTE format('CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
  END LOOP;
END $$;

-- storage：vehicle-photos（private，比照 sql/0029:112-119）
insert into storage.buckets (id, name, public) values ('vehicle-photos', 'vehicle-photos', false)
on conflict (id) do nothing;
update storage.buckets set public = false where id = 'vehicle-photos' and public is distinct from false;

-- ── 還原（新表刪除會連資料一起丟）──
-- DROP TRIGGER IF EXISTS vehicle_booking_sync ON public.leave_requests;
-- DROP FUNCTION IF EXISTS public.vehicle_booking_sync_from_request();
-- DROP TABLE IF EXISTS public.vehicle_trip_photos, public.vehicle_trip_costs, public.vehicle_trips,
--   public.vehicle_bookings, public.vehicle_maintenance_logs, public.vehicle_reminder_log, public.vehicle_settings, public.vehicles;
-- delete from storage.buckets where id = 'vehicle-photos';
