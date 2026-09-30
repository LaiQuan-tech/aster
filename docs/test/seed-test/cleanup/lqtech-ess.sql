-- =====================================================================
-- docs/test/seed-test/cleanup/lqtech-ess.sql — 清掉 lqtech-ess.mjs 替「萊乾資訊」建的員工端測試資料
-- （由 lqtech-ess.mjs 依 manifest last-run-lqtech.json 產生；獨立執行。
--   docs/test/清理-後台測試資料.sql 是「萊乾資訊以外」的【測試】資料，兩支互不相依、先後都可以）
--
-- 範圍：只刪 manifest 列出的 id（183 列），外加「業主測試時對這些列操作而由系統自動長出」
--   的列：payload 指向這些申請單／月表／專案的通知、request_id／source_request_id 指回這些申請單的
--   打卡／補休／預支、這些申請單的附件與簽核關卡、這些報銷的附件、這個專案的成員／文件／分潤異動。
-- 還原：萊乾資訊跑前沒有 employee_profiles 列 → 刪掉本工具建的那一列＝還原；employees 列從沒被改過。
-- 不處理：
--   • 業主測試時自己新送的單／報銷／打卡（不在 manifest，也不是本工具建的）。
--   • 萊乾資訊 2026-09 的出勤月表：系統在業主打開月表頁或每月 1 日排程時自動產生，不是本工具建的；
--     本工具沒有放任何 9 月打卡／班表／核准假單，清完後那張月表若仍是 draft，重開頁面會自動重算。
--   • audit_logs（append-only，保留稽核軌跡）。
-- Storage（SQL 刪不到；有的話先刪檔再跑本檔）：
--   SELECT storage_path FROM request_attachments WHERE request_id = ANY(<req_ids>);          -- bucket request-attachments
--   SELECT storage_path FROM expense_claim_attachments WHERE claim_id = ANY(<claim_ids>);   -- bucket expense-receipts
--   SELECT photo_storage_path FROM employee_profiles WHERE id = ANY(<profile_ids>);         -- bucket employee-documents
--   SELECT proof_storage_path FROM employee_educations WHERE id = ANY(<edu_ids>);           -- bucket employee-documents
--   SELECT attachment_storage_path FROM employee_certifications WHERE id = ANY(<cert_ids>); -- bucket employee-documents
--   （本工具沒有上傳任何檔案；只有業主測試時上傳過才會有）
-- 執行：Supabase Management API query 端點或 SQL Editor（單一交易，任何一句失敗整包回滾）。
--   sql/0018 forbid_hard_delete／0034 forbid_paid_bonus_mutation 只對 status IN ('test','demo') 的租戶放行
--   實體刪除：同一交易內切 demo → 刪 → 切回 active（與 docs/test/清理-後台測試資料.sql 同一套）。
-- 冪等：可重複執行（第二次全部 0 列）。每張表的「實刪/預期」會以 NOTICE（乾跑版為例外訊息）列出。
-- 產生時間：2026-09-30T05:00:11.629Z
-- =====================================================================

DO $$
DECLARE
  t uuid := '0507ad78-27f4-480e-b99f-a72db2aee50c';
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active (status=%)', t, (SELECT status FROM public.tenants WHERE id = t);
  END IF;
  PERFORM set_config('request.headers', '{"x-actor-route":"cleanup:lqtech-ess"}', true);
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

  -- >>> lqtech-ess fragment
  DECLARE
    lq              uuid    := '9b9ffd9d-f25d-4e26-9b36-d5f1afa9196d';   -- 萊乾資訊
    lq_dry_run      boolean := false;
    lq_report       text    := '';
    lq_n            integer;
    req_ids         uuid[]  := '{40ba9b03-fba2-568a-bd0a-1f8820e040b6,17ff4ab1-2e60-5efe-94c5-baa66578a3e6,f03fde04-4605-52a0-8c3e-36414dfa61fe,e62fedad-d987-5a61-807f-3162642daf5e,3334918f-66b1-530c-bca8-d3b45838b5fe,463c82b9-e24e-50b3-b8f2-9eccfe3c3175,94d92d28-f742-5870-abdb-a157a8545976,d8a18604-ca59-5e4b-8cb0-d2ccf0c458f3,fa913fc3-6752-505d-b211-d7707615f090,50ea1cd8-c0f9-57f7-8a05-2a59afdf996a,6c5ddd02-0bb6-584d-a193-9489adb38a3d,647cc8f9-a39d-569c-8b85-32445c68b871,4918702b-c8be-5c98-910a-1ba8001a2277,27053b17-ed1c-5657-8832-79fef6024486,25e4b80a-db8e-54db-adfa-3eb5b84b0a6d,c0b4052d-e56c-58de-b5c7-bd3b05de802b,66658949-4282-5e1b-a640-112580ca7b1e,d07ff53e-7842-561c-a3ca-201040f67317,465e6974-e133-544f-8027-9d0ebc66bd51,fe812890-9ebf-5972-a7b7-0956c3f93aab,16967ffd-d704-53cd-b8fa-698bd54bc256,26fc23c3-5e4e-538b-aa74-67d8544d05be}'::uuid[];
    step_ids        uuid[]  := '{4e8377b3-7367-523c-8633-fcc06e3c6278,3c1109e6-e84b-5baf-a7e1-f8904a7ed6e3,6fd69a35-4319-55fd-b787-fc2e15c9ddba,a3781fab-ab1f-54b5-bd02-b2b9f149a603,4507f9aa-2b33-59c8-84f0-23d9bd259d3f,db0f85f4-92e5-5f40-95f1-b6893e826a4c,1117f1a4-7c9d-5a6b-831c-97c41a40fc5a,3838961b-ac62-582f-bf50-64b757bec9b7,6903a818-8cba-5662-9603-c041e461d01f,b6ba3ca5-6d17-5a29-a422-21337dbd1a30,d5fab93f-5042-56db-952b-2a89efe679ee,3c6d446e-671c-56d6-938e-e23d4240a0fe,ede1d755-a998-53c1-a0bd-5d1d16139f30,fc7089f7-45d5-50ac-9c05-1cfdea23c0cc,86f63300-553c-53bd-b27b-2846bf113be5,edd0572e-aa98-511f-b90b-ad4b6d40cdb8,f4373dae-dad6-5a3a-8484-5fbea7e2c3ab,136ea37a-57ff-575f-8b9d-570d7dd11d9c,f1d392ac-2ed7-529c-a0be-cb778bfcd516,eb419ae7-588a-5e45-94c2-a433636c3ef9,3cf87001-9317-5834-87a8-a150f5838837,3238f487-59da-5373-8d5e-ff7db434b774}'::uuid[];
    punch_ids       uuid[]  := '{b9bc27e0-62eb-5718-b8d2-b1b4e3fde044,b683b8d8-d100-54e5-ab3f-dc7225115611,4db7d0c8-be8d-5bdb-a722-7ea6ea2a96fc,b67a8de0-70ed-5f6d-9a49-7e1ae97caa30,55454070-0b69-55ca-baf5-9996b99aa090,3c19d6d3-09b1-572b-8cef-6098dcdd5d65,51fc8c73-cbec-5a53-83b9-7ec42fe9ef30,32a484c1-29d9-569c-8065-4b8c63f43a20,1553c253-ca80-5f6e-b6f5-d0a579484411,e148c5ee-e7a8-5318-8f0f-1a855002221d,ce17385b-c80c-5bbb-aa75-f42f946ba37f,e676d24d-4de9-54de-ae57-b2d9cb3d7ae6,6aa5505c-7bf9-5a3e-9b01-0603ef4a4f99,485f53dc-0c65-59a2-8d8c-fdd095c9ec9b,0260c213-4914-51b6-a584-3128405aef6b,6c5a7644-e8e7-5901-89b8-ae94bb22b18f,6690e3b4-9965-50fb-8ed9-b9cc1d718953,054643f9-8527-58dc-a775-752fc6fa14eb,8cf6b6c2-016b-5441-bf40-d033b8a77718,c8fe8237-2801-546e-899b-9ec7c4acf9bb,bae81980-57fa-530e-9d28-47516b3645f1,f1014174-89aa-5af1-80e9-e6f2e5677010,0134a98e-4f4c-55d5-9a54-8861bb4671f7,198fc7b1-a813-50c5-af38-23b08ce6f8b3,ee5a1e9b-95ba-5fb6-a05c-763812fd728d,3a4b89aa-6283-5d81-a61e-760fc4f219da,6d0c87de-e4e8-5660-97bb-2eb266b9f7ab,ca51e278-e664-54d6-ae78-75d6e3cc932f,925c90f6-6318-5acf-9880-cc8d0c30f2a3,70d5f629-86fe-58d6-b3d1-1b93654bc22e,0f414ef8-9205-533a-95a8-000c2a25b626,dd825f3a-328e-5bbf-8f66-e6a071005aba,329e8945-4b8e-5e29-959b-e7897a8652f1,075914e2-a411-57cd-adbf-221b54f6eea3,c854683c-6a52-5212-b939-32766a2ad157,8f9e841c-8b9d-579f-9ba1-6cef19d927c9,ae153b60-fcd3-56f2-8ae9-28cb5c43caeb,a307792d-7871-5419-83ca-704ba7acea06}'::uuid[];
    schedule_ids    uuid[]  := '{ed1d3f69-d003-5e2a-9caa-597fbe83ce23,80c16420-aa45-5ae7-924d-4d4d25f82225,6a1a8583-0a1f-58ab-88dd-02bc72940e3d,844fef13-b27b-5391-99ee-db6facebfddc,830cab1a-82a1-5174-a244-34c71f1cd0dd,ded00324-94fb-513f-b0bc-055a97638350,5e8a9b13-485e-5331-97ea-e6adb74b2199,9d07b22e-729f-53b8-a91e-4884df6c91fd,db59b70a-33ac-556b-8d35-cc167615df1f,c07d34df-9c63-57e9-8e94-41660f88efc8,5f204c71-6984-57e5-88b5-82c6911d1fdf,c4921a8a-9e2d-52df-bd62-bca6a60d613f,ec84754c-94dd-556a-8f42-532558aec58e,1f154211-8587-5860-b63d-5f4a91eb9f2d,ddd9c602-2b7c-55c3-abe9-c433cfca878d,26d4b581-f407-5b3e-a5d8-f82f5aaaf14f,031838a0-94bd-5bea-9626-cbac0fb3c9b3,4146aea2-e9c3-5623-8097-f1975d0c99ba,c1e39026-9efe-5173-b7d1-0e49a7c51d2b,c4319de1-b041-50dc-ad54-0565f0d2e6c4,9d9c40a5-3a02-53bc-af6c-e658e628b56f}'::uuid[];
    comp_ids        uuid[]  := '{72c52899-3a1c-5a82-9fde-e168cc6a40cb}'::uuid[];
    advance_ids     uuid[]  := '{8c8d6480-3265-55cb-8e10-2b1a6c8d71e7,7aa62227-4d75-5cae-9213-8ef1e7df3ec1}'::uuid[];
    balance_ids     uuid[]  := '{28c51f55-416d-58d5-89e4-4255d60f8d7e,c3860ddb-5062-5a6e-8be6-50b03d4f4758,1ccd3e23-27b6-58a5-87f3-c9866fda67fb,3c41c4c5-3553-59f3-a25e-8e4a678cd50e}'::uuid[];
    claim_ids       uuid[]  := '{ed24f19c-40e9-558a-aef2-1713ddf45a94,2143e163-085f-5d94-b39c-4e288642fc57,3b1ae296-01b4-5067-b44e-346422f490e0,e622a5e7-5c24-55eb-abdd-8a1d47c4f30d}'::uuid[];
    payslip_ids     uuid[]  := '{829efd15-7de9-54b2-bab8-48f354cb344d}'::uuid[];
    kpi_ids         uuid[]  := '{34cc6074-e4c0-5195-87c7-8b857d76c8eb}'::uuid[];
    member_ids      uuid[]  := '{096be1e2-9684-56cd-a958-fc96f8180edf}'::uuid[];
    project_ids     uuid[]  := '{324f8933-a7d9-5684-a582-fcdecfd6a5c5}'::uuid[];
    template_ids    uuid[]  := '{c2199bb5-03d3-5a33-af3e-8913ee026750}'::uuid[];
    bonus_run_ids   uuid[]  := '{93e67f24-f822-5802-8805-67a330062996}'::uuid[];
    bonus_item_ids  uuid[]  := '{68c980d7-0b43-5f26-9125-33eb21e9c487}'::uuid[];
    sheet_ids       uuid[]  := '{ef2102b0-0626-4359-a7dc-1f74814fab40}'::uuid[];
    sheet_day_ids   uuid[]  := '{5475da86-f2b9-4ef5-990a-9e97c24f7ab4,b60e55ba-3064-4cbb-9391-b3632a1ee2db,ed21cb8c-2860-421a-9237-79e1f18920a0,d09fd061-ad19-404c-842f-715cbc07400b,f1342e48-25ac-4e8b-8e2e-a6e3cacfb880,87619787-6ad8-49fe-9e6b-40cb5971023e,0c8d1d89-e76f-42b7-b5d9-01880a24c16b,ec6c091b-87a6-4142-99b8-ee9a3261d822,a75a4547-c81c-4e13-a6ca-659e98c9e4e8,56777b4c-549c-4d67-acea-85b9679f7b7f,42efcee9-8b75-4a67-9331-a5b3d2a800a3,67941ed6-8251-4f54-b321-757632a4905d,b2e0a997-7073-4fb4-8e19-0f8579c26fdd,d355745d-00e3-44b3-aac7-023e1191336f,e78d45ac-499a-4a48-b0ae-0afea5a5ccd2,2cc255e8-4213-4661-90e6-4fd271500bbf,a4a22676-318c-48f0-a577-d913e688cf4c,83feb7ff-5fe2-4279-9d7b-31f66d2b221f,79f8c347-76ea-4d97-afb9-399ecabe938c,ef09d84e-3aa2-47fa-b336-9342a08ca911,f3d16301-2eeb-4f84-84fb-ba16b92940e3,e823fad2-a122-4d5b-9106-a71714cc120b,e6dadf67-9ed9-4661-a620-bb34a26cfd64,96caed30-570f-4648-8025-cc9091d840c9,9dcccf9d-9f2c-4c62-ab2e-f94dba00c3bc,eec0c5ee-69e6-45c3-9414-5e405160de7f,b7d1b0ef-ba44-406d-bfe2-cef746635250,63e90d4e-f9e6-4fab-9b90-9821a4df5e65,5d639e01-5bf0-4fed-82df-f0ade8f1c362,3d5a4286-1622-4196-a063-d849f4a765de,d3d7bac5-3fb0-4024-b3a5-57d00557a375}'::uuid[];
    attday_ids      uuid[]  := '{283cca9d-d319-4a36-be6b-1ec291bbd920,149fc5d5-b031-4688-a13e-7b3cadef7e09,67790939-3384-4deb-9703-3ea008c1bb0e,bb4deac5-6d1b-4fce-bf7c-5bbfa6a26acf,36a1df4b-2b27-4faf-9829-e007551a76ab,d6128fbc-1784-4539-b69a-3dec16e7b899,47cccf8a-1a17-4a79-a202-c244a135f732,43015db5-2934-4fd9-af99-1dd769fe7d30,f0ae4d63-2725-4df0-bede-0033f31b10c7,153fbc9e-4940-4458-a104-a83137ed0780,a16cb8ac-14de-48e3-8678-52f10581c724,2a412e62-bb53-4e9a-bc30-3bc9cd6b7507,d54942b2-dae5-4092-a671-23d0311d2305,9269eff6-de1c-4ca9-9693-8d48fe7a84f0,c6eebdf8-75b7-4284-9f23-98c96a7e1ae8,3b763660-8fa8-4a05-8229-01fd3ef8a4fd,77c97ce2-1f62-4151-884f-3654de291e47,f3a3b217-88bf-4f13-a897-14be08ae2f62,360be0e6-96e7-4d73-b8d1-9b78f85faf85,36c0d2c1-567e-47f4-9326-4bcc64cdb1d1,aac0ff18-a4ca-43f1-b055-d416bc1ae45a}'::uuid[];
    notif_ids       uuid[]  := '{5d6e7229-47e4-5fab-8b05-dea7935607c5,aba6fba5-8b7a-593b-88a3-b9898220dd84,5ce6dcbd-6d8d-50d7-bb97-a7c324d2d404,bdb3a819-043a-5b99-8d42-a9c04bdf7b08}'::uuid[];
    profile_ids     uuid[]  := '{3547b847-3d1a-50bf-91f8-68dbb27e6c5a}'::uuid[];
    edu_ids         uuid[]  := '{a96d296f-6a98-5198-9c41-44945243f75d}'::uuid[];
    cert_ids        uuid[]  := '{01647e0e-6158-56d0-ba57-a84e254e8dc5}'::uuid[];
    work_ids        uuid[]  := '{1cfa5934-f892-5c7f-a6f0-2fc6dc699eeb}'::uuid[];
    job_ids         uuid[]  := '{152d1926-b11d-5004-8f8f-dbe9ba0681e9}'::uuid[];
  BEGIN
    -- 1. 通知：本工具建的（id）＋任何指向本工具申請單／月表／專案的通知（業主測試時操作產生的）
    DELETE FROM public.notifications WHERE tenant_id = t AND (id = ANY(notif_ids) OR payload ->> 'requestId' = ANY(req_ids::text[]) OR payload ->> 'sheetId' = ANY(sheet_ids::text[]) OR payload ->> 'projectId' = ANY(project_ids::text[]));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'notifications', lq_n, 4);
    -- 2. 報銷（先附件再單；業主若替這幾張單上傳收據，Storage 檔另刪，見檔頭）
    DELETE FROM public.expense_claim_attachments WHERE tenant_id = t AND claim_id = ANY(claim_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'expense_claim_attachments', lq_n, '-');
    DELETE FROM public.expense_claims WHERE tenant_id = t AND id = ANY(claim_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'expense_claims', lq_n, 4);
    -- 3. 預支／補休／打卡：本工具建的＋核准本工具申請單時系統自動長出的（request_id／source_request_id 指回來）
    DELETE FROM public.advances WHERE tenant_id = t AND (id = ANY(advance_ids) OR request_id = ANY(req_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'advances', lq_n, 2);
    DELETE FROM public.comp_time_ledger WHERE tenant_id = t AND (id = ANY(comp_ids) OR source_request_id = ANY(req_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'comp_time_ledger', lq_n, 1);
    DELETE FROM public.punch_records WHERE tenant_id = t AND (id = ANY(punch_ids) OR request_id = ANY(req_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'punch_records', lq_n, 38);
    -- 4. 申請單（附件 → 簽核關卡 → 單）
    DELETE FROM public.request_attachments WHERE tenant_id = t AND request_id = ANY(req_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'request_attachments', lq_n, '-');
    DELETE FROM public.approval_steps WHERE tenant_id = t AND (id = ANY(step_ids) OR request_id = ANY(req_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'approval_steps', lq_n, 22);
    DELETE FROM public.leave_requests WHERE tenant_id = t AND id = ANY(req_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'leave_requests', lq_n, 22);
    -- 5. 假別餘額（萊乾資訊 2026 曆年桶 3 列）
    DELETE FROM public.leave_balances WHERE tenant_id = t AND id = ANY(balance_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'leave_balances', lq_n, 4);
    -- 6. 出勤月表（快照 → 逐日 → 月表）與結算結果
    DELETE FROM public.attendance_sheet_snapshots WHERE tenant_id = t AND sheet_id = ANY(sheet_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'attendance_sheet_snapshots', lq_n, '-');
    DELETE FROM public.attendance_sheet_days WHERE tenant_id = t AND (id = ANY(sheet_day_ids) OR sheet_id = ANY(sheet_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'attendance_sheet_days', lq_n, 31);
    DELETE FROM public.attendance_sheets WHERE tenant_id = t AND id = ANY(sheet_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'attendance_sheets', lq_n, 1);
    DELETE FROM public.attendance_days WHERE tenant_id = t AND (id = ANY(attday_ids) OR (employee_id = lq AND work_date = ANY('{2026-08-03,2026-08-04,2026-08-05,2026-08-06,2026-08-07,2026-08-10,2026-08-11,2026-08-12,2026-08-13,2026-08-14,2026-08-17,2026-08-18,2026-08-19,2026-08-20,2026-08-21,2026-08-24,2026-08-25,2026-08-26,2026-08-27,2026-08-28,2026-08-31}'::date[])));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'attendance_days', lq_n, 21);
    DELETE FROM public.schedules WHERE tenant_id = t AND id = ANY(schedule_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'schedules', lq_n, 21);
    -- 7. 薪資單／考核（考核 → 萊乾資訊專用範本）／分潤（明細 → 批次；成員 → 萊乾資訊專用專案）
    DELETE FROM public.payslips WHERE tenant_id = t AND id = ANY(payslip_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'payslips', lq_n, 1);
    DELETE FROM public.kpi_reviews WHERE tenant_id = t AND (id = ANY(kpi_ids) OR template_id = ANY(template_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'kpi_reviews', lq_n, 1);
    DELETE FROM public.kpi_templates WHERE tenant_id = t AND id = ANY(template_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'kpi_templates', lq_n, 1);
    DELETE FROM public.bonus_run_items WHERE tenant_id = t AND (id = ANY(bonus_item_ids) OR run_id = ANY(bonus_run_ids) OR project_id = ANY(project_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'bonus_run_items', lq_n, 1);
    DELETE FROM public.bonus_runs WHERE tenant_id = t AND id = ANY(bonus_run_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'bonus_runs', lq_n, 1);
    DELETE FROM public.project_members WHERE tenant_id = t AND (id = ANY(member_ids) OR project_id = ANY(project_ids));
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'project_members', lq_n, 1);
    DELETE FROM public.project_share_adjustments WHERE tenant_id = t AND project_id = ANY(project_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'project_share_adjustments', lq_n, '-');
    DELETE FROM public.project_documents WHERE tenant_id = t AND project_id = ANY(project_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'project_documents', lq_n, '-');
    DELETE FROM public.projects WHERE tenant_id = t AND id = ANY(project_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'projects', lq_n, 1);
    -- 8. 我的資料：四張子表的【測試】列，最後刪個人檔案列＝還原（跑前萊乾資訊沒有 employee_profiles 列）
    DELETE FROM public.employee_educations WHERE tenant_id = t AND id = ANY(edu_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'employee_educations', lq_n, 1);
    DELETE FROM public.employee_certifications WHERE tenant_id = t AND id = ANY(cert_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'employee_certifications', lq_n, 1);
    DELETE FROM public.employee_work_history WHERE tenant_id = t AND id = ANY(work_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'employee_work_history', lq_n, 1);
    DELETE FROM public.employee_job_history WHERE tenant_id = t AND id = ANY(job_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'employee_job_history', lq_n, 1);
    DELETE FROM public.employee_profiles WHERE tenant_id = t AND employee_id = lq AND id = ANY(profile_ids);
    GET DIAGNOSTICS lq_n = ROW_COUNT;
    lq_report := lq_report || format('%s=%s/%s ', 'employee_profiles', lq_n, 1);
    IF lq_dry_run THEN
      RAISE EXCEPTION 'DRY_RUN_ROLLBACK lqtech-ess（全部語句都能執行，這裡故意回滾）deleted/expected: %', lq_report;
    END IF;
    RAISE NOTICE 'lqtech-ess cleanup deleted/expected: %', lq_report;
  END;
  -- <<< lqtech-ess fragment

  UPDATE public.tenants SET status = 'active' WHERE id = t;
END $$;
