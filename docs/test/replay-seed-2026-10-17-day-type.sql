-- pglite replay 用的假資料（docs/套用-2026-10-17-一例一休日別.sql）：兩個租戶、舊版 generate 產生的 2026 行事曆片段。
-- ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
insert into public.tenants (id, name, status) values
  ('d0000000-0000-4000-8000-000000000001', '測試租戶一', 'active'),
  ('d0000000-0000-4000-8000-000000000002', '測試租戶二', 'active');
update public.tenants set features = '{"attendance": {"regularLeaveWeekday": 6}}'::jsonb where id = 'd0000000-0000-4000-8000-000000000002';
insert into public.tenant_calendar_days (tenant_id, date, day_type, label, source) values
  -- 租戶一（預設週休）：週末國定假日被標成 fixed_holiday、週日是 rest_day、一筆 HR 手動
  ('d0000000-0000-4000-8000-000000000001', '2026-02-27', 'fixed_holiday', '和平紀念日補假（2/28適逢週六）', 'import'),
  ('d0000000-0000-4000-8000-000000000001', '2026-02-28', 'fixed_holiday', '和平紀念日', 'import'),
  ('d0000000-0000-4000-8000-000000000001', '2026-04-05', 'fixed_holiday', '清明節', 'import'),
  ('d0000000-0000-4000-8000-000000000001', '2026-10-10', 'fixed_holiday', '國慶日', 'import'),
  ('d0000000-0000-4000-8000-000000000001', '2026-10-25', 'fixed_holiday', '台灣光復暨金門古寧頭大捷紀念日', 'manual'),
  ('d0000000-0000-4000-8000-000000000001', '2026-03-07', 'rest_day', null, 'generated'),
  ('d0000000-0000-4000-8000-000000000001', '2026-03-08', 'rest_day', null, 'generated'),
  ('d0000000-0000-4000-8000-000000000001', '2026-03-15', 'rest_day', null, 'manual'),
  ('d0000000-0000-4000-8000-000000000001', '2027-01-03', 'rest_day', null, 'generated'),
  -- 租戶二（例假週六）：週六 rest_day → regular_leave、週日維持 rest_day
  ('d0000000-0000-4000-8000-000000000002', '2026-03-07', 'rest_day', null, 'generated'),
  ('d0000000-0000-4000-8000-000000000002', '2026-03-08', 'rest_day', null, 'generated'),
  ('d0000000-0000-4000-8000-000000000002', '2026-04-04', 'fixed_holiday', '兒童節', 'import');
-- 已結算月份不動（2026-10-17 驗收修正 B2）：租戶一 2026-02 已結算 → 2/28 週末國定假日本日維持 fixed_holiday；
-- 2026-09 已結算 → 9/6 週日維持 rest_day；租戶二 2026-03 曾結算後重新開放（reopened）→ 照常改。
insert into public.tenant_calendar_days (tenant_id, date, day_type, label, source) values
  ('d0000000-0000-4000-8000-000000000001', '2026-09-06', 'rest_day', null, 'generated');
insert into public.period_closes (tenant_id, period, status, reopened_at, reopen_reason) values
  ('d0000000-0000-4000-8000-000000000001', '2026-02', 'closed', null, null),
  ('d0000000-0000-4000-8000-000000000001', '2026-09', 'closed', null, null),
  ('d0000000-0000-4000-8000-000000000002', '2026-03', 'reopened', now(), '測試：重新開放');
