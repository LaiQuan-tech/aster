-- =====================================================================
-- 亞斯特 — 清除「萊乾資訊以外」的後台【測試】資料（由 docs/test/seed-test/cleanup/build.mjs 產生）
--
-- 用途：業主驗完後台功能後，一次刪光 docs/test/seed-test/*.mjs 與驗收灌進正式租戶的測試資料：
--   【測試】員工（T001～T005、報到者C）與他們名下的一切、測試部與子組、假別／班別／行事曆／
--   內部連結、專案／合約／期款／副委託／放款／獎金批次／客戶／廠商／公司主體、排班／打卡／出勤日／
--   月表／假單／簽核／餘額／預支／補休、薪資結構／薪資單／調薪／眷屬／非員工所得／費用類別／報銷／月結、
--   報到／招募／考核／專屬信箱／公告（含簽收列）／公司資訊頁／知識庫，以及掛在測試員工、提到【測試】
--   或指向這些資料的通知。
-- 保留：萊乾資訊（9b9ffd9d-f25d-4e26-9b36-d5f1afa9196d）與 docs/test/seed-test/last-run-lqtech.json 列出的 183 列，以及測試同仁
--   T002【測試】測試員工B（6d7ceda1-d5c8-411c-80d1-841b5ccbf96d） 的員工列、所在【測試】部門、原有特休餘額列（lq_keep；每一句
--   DELETE／UPDATE 都排除）。B 的其他 seed-test 資料照清。要清萊乾資訊自己的測試資料用 cleanup/lqtech-ess.sql。
-- 不動：真實員工與他們的任何資料、租戶設定（features 只移除【測試】內部連結）、audit_logs、Storage 備份快照。
-- 前置：先跑 `node docs/test/seed-test/cleanup/storage.mjs` 刪 Storage 檔（它要先從 DB 讀路徑）。
-- 之後：auth 登入帳號用 Supabase admin API 刪（清單見乾跑訊息「要用 admin API 刪的 auth 帳號」）。
-- 執行：Supabase Management API query 端點或 SQL Editor（單一交易，任何一句失敗整包回滾）。
--   結尾驗證 (a)／(a2)／(b)／features 任一項不為 0 就整包回滾（見 build.mjs 檔頭）。
-- 冪等：可重複執行（第二次全部 0 列）。
-- =====================================================================

DO $$
DECLARE
  t        uuid := '0507ad78-27f4-480e-b99f-a72db2aee50c';
  test_emp uuid[];
  lq       uuid := '9b9ffd9d-f25d-4e26-9b36-d5f1afa9196d';   -- 萊乾資訊：永遠保留
  -- 萊乾資訊 manifest 的全部 id＋萊乾資訊員工本身＋測試同仁 B 的保留項目（保護：每一句 DELETE／UPDATE 都排除）
  lq_keep  uuid[] := '{9b9ffd9d-f25d-4e26-9b36-d5f1afa9196d,ed1d3f69-d003-5e2a-9caa-597fbe83ce23,80c16420-aa45-5ae7-924d-4d4d25f82225,6a1a8583-0a1f-58ab-88dd-02bc72940e3d,844fef13-b27b-5391-99ee-db6facebfddc,830cab1a-82a1-5174-a244-34c71f1cd0dd,ded00324-94fb-513f-b0bc-055a97638350,5e8a9b13-485e-5331-97ea-e6adb74b2199,9d07b22e-729f-53b8-a91e-4884df6c91fd,db59b70a-33ac-556b-8d35-cc167615df1f,c07d34df-9c63-57e9-8e94-41660f88efc8,5f204c71-6984-57e5-88b5-82c6911d1fdf,c4921a8a-9e2d-52df-bd62-bca6a60d613f,ec84754c-94dd-556a-8f42-532558aec58e,1f154211-8587-5860-b63d-5f4a91eb9f2d,ddd9c602-2b7c-55c3-abe9-c433cfca878d,26d4b581-f407-5b3e-a5d8-f82f5aaaf14f,031838a0-94bd-5bea-9626-cbac0fb3c9b3,4146aea2-e9c3-5623-8097-f1975d0c99ba,c1e39026-9efe-5173-b7d1-0e49a7c51d2b,c4319de1-b041-50dc-ad54-0565f0d2e6c4,9d9c40a5-3a02-53bc-af6c-e658e628b56f,b9bc27e0-62eb-5718-b8d2-b1b4e3fde044,b683b8d8-d100-54e5-ab3f-dc7225115611,4db7d0c8-be8d-5bdb-a722-7ea6ea2a96fc,b67a8de0-70ed-5f6d-9a49-7e1ae97caa30,55454070-0b69-55ca-baf5-9996b99aa090,3c19d6d3-09b1-572b-8cef-6098dcdd5d65,51fc8c73-cbec-5a53-83b9-7ec42fe9ef30,32a484c1-29d9-569c-8065-4b8c63f43a20,1553c253-ca80-5f6e-b6f5-d0a579484411,e148c5ee-e7a8-5318-8f0f-1a855002221d,ce17385b-c80c-5bbb-aa75-f42f946ba37f,e676d24d-4de9-54de-ae57-b2d9cb3d7ae6,6aa5505c-7bf9-5a3e-9b01-0603ef4a4f99,485f53dc-0c65-59a2-8d8c-fdd095c9ec9b,0260c213-4914-51b6-a584-3128405aef6b,6c5a7644-e8e7-5901-89b8-ae94bb22b18f,6690e3b4-9965-50fb-8ed9-b9cc1d718953,054643f9-8527-58dc-a775-752fc6fa14eb,8cf6b6c2-016b-5441-bf40-d033b8a77718,c8fe8237-2801-546e-899b-9ec7c4acf9bb,bae81980-57fa-530e-9d28-47516b3645f1,f1014174-89aa-5af1-80e9-e6f2e5677010,0134a98e-4f4c-55d5-9a54-8861bb4671f7,198fc7b1-a813-50c5-af38-23b08ce6f8b3,ee5a1e9b-95ba-5fb6-a05c-763812fd728d,3a4b89aa-6283-5d81-a61e-760fc4f219da,6d0c87de-e4e8-5660-97bb-2eb266b9f7ab,ca51e278-e664-54d6-ae78-75d6e3cc932f,925c90f6-6318-5acf-9880-cc8d0c30f2a3,70d5f629-86fe-58d6-b3d1-1b93654bc22e,0f414ef8-9205-533a-95a8-000c2a25b626,dd825f3a-328e-5bbf-8f66-e6a071005aba,329e8945-4b8e-5e29-959b-e7897a8652f1,075914e2-a411-57cd-adbf-221b54f6eea3,c854683c-6a52-5212-b939-32766a2ad157,8f9e841c-8b9d-579f-9ba1-6cef19d927c9,ae153b60-fcd3-56f2-8ae9-28cb5c43caeb,a307792d-7871-5419-83ca-704ba7acea06,40ba9b03-fba2-568a-bd0a-1f8820e040b6,17ff4ab1-2e60-5efe-94c5-baa66578a3e6,f03fde04-4605-52a0-8c3e-36414dfa61fe,e62fedad-d987-5a61-807f-3162642daf5e,3334918f-66b1-530c-bca8-d3b45838b5fe,463c82b9-e24e-50b3-b8f2-9eccfe3c3175,94d92d28-f742-5870-abdb-a157a8545976,d8a18604-ca59-5e4b-8cb0-d2ccf0c458f3,fa913fc3-6752-505d-b211-d7707615f090,50ea1cd8-c0f9-57f7-8a05-2a59afdf996a,6c5ddd02-0bb6-584d-a193-9489adb38a3d,647cc8f9-a39d-569c-8b85-32445c68b871,4918702b-c8be-5c98-910a-1ba8001a2277,27053b17-ed1c-5657-8832-79fef6024486,25e4b80a-db8e-54db-adfa-3eb5b84b0a6d,c0b4052d-e56c-58de-b5c7-bd3b05de802b,66658949-4282-5e1b-a640-112580ca7b1e,d07ff53e-7842-561c-a3ca-201040f67317,465e6974-e133-544f-8027-9d0ebc66bd51,fe812890-9ebf-5972-a7b7-0956c3f93aab,16967ffd-d704-53cd-b8fa-698bd54bc256,26fc23c3-5e4e-538b-aa74-67d8544d05be,4e8377b3-7367-523c-8633-fcc06e3c6278,3c1109e6-e84b-5baf-a7e1-f8904a7ed6e3,6fd69a35-4319-55fd-b787-fc2e15c9ddba,a3781fab-ab1f-54b5-bd02-b2b9f149a603,4507f9aa-2b33-59c8-84f0-23d9bd259d3f,db0f85f4-92e5-5f40-95f1-b6893e826a4c,1117f1a4-7c9d-5a6b-831c-97c41a40fc5a,3838961b-ac62-582f-bf50-64b757bec9b7,6903a818-8cba-5662-9603-c041e461d01f,b6ba3ca5-6d17-5a29-a422-21337dbd1a30,d5fab93f-5042-56db-952b-2a89efe679ee,3c6d446e-671c-56d6-938e-e23d4240a0fe,ede1d755-a998-53c1-a0bd-5d1d16139f30,fc7089f7-45d5-50ac-9c05-1cfdea23c0cc,86f63300-553c-53bd-b27b-2846bf113be5,edd0572e-aa98-511f-b90b-ad4b6d40cdb8,f4373dae-dad6-5a3a-8484-5fbea7e2c3ab,136ea37a-57ff-575f-8b9d-570d7dd11d9c,f1d392ac-2ed7-529c-a0be-cb778bfcd516,eb419ae7-588a-5e45-94c2-a433636c3ef9,3cf87001-9317-5834-87a8-a150f5838837,3238f487-59da-5373-8d5e-ff7db434b774,72c52899-3a1c-5a82-9fde-e168cc6a40cb,8c8d6480-3265-55cb-8e10-2b1a6c8d71e7,7aa62227-4d75-5cae-9213-8ef1e7df3ec1,28c51f55-416d-58d5-89e4-4255d60f8d7e,c3860ddb-5062-5a6e-8be6-50b03d4f4758,1ccd3e23-27b6-58a5-87f3-c9866fda67fb,3c41c4c5-3553-59f3-a25e-8e4a678cd50e,829efd15-7de9-54b2-bab8-48f354cb344d,ed24f19c-40e9-558a-aef2-1713ddf45a94,2143e163-085f-5d94-b39c-4e288642fc57,3b1ae296-01b4-5067-b44e-346422f490e0,e622a5e7-5c24-55eb-abdd-8a1d47c4f30d,c2199bb5-03d3-5a33-af3e-8913ee026750,34cc6074-e4c0-5195-87c7-8b857d76c8eb,324f8933-a7d9-5684-a582-fcdecfd6a5c5,096be1e2-9684-56cd-a958-fc96f8180edf,93e67f24-f822-5802-8805-67a330062996,68c980d7-0b43-5f26-9125-33eb21e9c487,3547b847-3d1a-50bf-91f8-68dbb27e6c5a,a96d296f-6a98-5198-9c41-44945243f75d,01647e0e-6158-56d0-ba57-a84e254e8dc5,1cfa5934-f892-5c7f-a6f0-2fc6dc699eeb,152d1926-b11d-5004-8f8f-dbe9ba0681e9,5d6e7229-47e4-5fab-8b05-dea7935607c5,aba6fba5-8b7a-593b-88a3-b9898220dd84,5ce6dcbd-6d8d-50d7-bb97-a7c324d2d404,bdb3a819-043a-5b99-8d42-a9c04bdf7b08,ef2102b0-0626-4359-a7dc-1f74814fab40,5475da86-f2b9-4ef5-990a-9e97c24f7ab4,b60e55ba-3064-4cbb-9391-b3632a1ee2db,ed21cb8c-2860-421a-9237-79e1f18920a0,d09fd061-ad19-404c-842f-715cbc07400b,f1342e48-25ac-4e8b-8e2e-a6e3cacfb880,87619787-6ad8-49fe-9e6b-40cb5971023e,0c8d1d89-e76f-42b7-b5d9-01880a24c16b,ec6c091b-87a6-4142-99b8-ee9a3261d822,a75a4547-c81c-4e13-a6ca-659e98c9e4e8,56777b4c-549c-4d67-acea-85b9679f7b7f,42efcee9-8b75-4a67-9331-a5b3d2a800a3,67941ed6-8251-4f54-b321-757632a4905d,b2e0a997-7073-4fb4-8e19-0f8579c26fdd,d355745d-00e3-44b3-aac7-023e1191336f,e78d45ac-499a-4a48-b0ae-0afea5a5ccd2,2cc255e8-4213-4661-90e6-4fd271500bbf,a4a22676-318c-48f0-a577-d913e688cf4c,83feb7ff-5fe2-4279-9d7b-31f66d2b221f,79f8c347-76ea-4d97-afb9-399ecabe938c,ef09d84e-3aa2-47fa-b336-9342a08ca911,f3d16301-2eeb-4f84-84fb-ba16b92940e3,e823fad2-a122-4d5b-9106-a71714cc120b,e6dadf67-9ed9-4661-a620-bb34a26cfd64,96caed30-570f-4648-8025-cc9091d840c9,9dcccf9d-9f2c-4c62-ab2e-f94dba00c3bc,eec0c5ee-69e6-45c3-9414-5e405160de7f,b7d1b0ef-ba44-406d-bfe2-cef746635250,63e90d4e-f9e6-4fab-9b90-9821a4df5e65,5d639e01-5bf0-4fed-82df-f0ade8f1c362,3d5a4286-1622-4196-a063-d849f4a765de,d3d7bac5-3fb0-4024-b3a5-57d00557a375,283cca9d-d319-4a36-be6b-1ec291bbd920,149fc5d5-b031-4688-a13e-7b3cadef7e09,67790939-3384-4deb-9703-3ea008c1bb0e,bb4deac5-6d1b-4fce-bf7c-5bbfa6a26acf,36a1df4b-2b27-4faf-9829-e007551a76ab,d6128fbc-1784-4539-b69a-3dec16e7b899,47cccf8a-1a17-4a79-a202-c244a135f732,43015db5-2934-4fd9-af99-1dd769fe7d30,f0ae4d63-2725-4df0-bede-0033f31b10c7,153fbc9e-4940-4458-a104-a83137ed0780,a16cb8ac-14de-48e3-8678-52f10581c724,2a412e62-bb53-4e9a-bc30-3bc9cd6b7507,d54942b2-dae5-4092-a671-23d0311d2305,9269eff6-de1c-4ca9-9693-8d48fe7a84f0,c6eebdf8-75b7-4284-9f23-98c96a7e1ae8,3b763660-8fa8-4a05-8229-01fd3ef8a4fd,77c97ce2-1f62-4151-884f-3654de291e47,f3a3b217-88bf-4f13-a897-14be08ae2f62,360be0e6-96e7-4d73-b8d1-9b78f85faf85,36c0d2c1-567e-47f4-9326-4bcc64cdb1d1,aac0ff18-a4ca-43f1-b055-d416bc1ae45a,6d7ceda1-d5c8-411c-80d1-841b5ccbf96d,66091721-b4e7-4c61-9033-05fe76e0e135,3241aaf3-f758-467f-bc6c-aad36f215e5d}'::uuid[];
  f_before jsonb;
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active (status=%)', t, (SELECT status FROM public.tenants WHERE id = t);
  END IF;
  -- 測試員工＝名字以【測試】開頭（T001～T005 ＋ 報到完成產生的無帳號報到者C）；萊乾資訊明確排除。
  -- 測試同仁 B 刻意留在 test_emp 裡：B 的其他 seed-test 資料照清，B 的員工列等保留項目靠 lq_keep 擋下。
  SELECT COALESCE(array_agg(id), '{}') INTO test_emp
    FROM public.employees WHERE tenant_id = t AND name LIKE '【測試】%' AND id <> lq;
  RAISE NOTICE 'test employees: %', COALESCE(array_length(test_emp, 1), 0);

  -- 稽核 context（驗證靠它找出本交易刪掉的列）；三張沒有 DELETE 稽核的表先快照
  PERFORM set_config('request.headers', '{"x-actor-route":"cleanup:other-test-data"}', true);
  SELECT features INTO f_before FROM public.tenants WHERE id = t;
  CREATE TEMP TABLE _pre_notif ON COMMIT DROP AS
    SELECT id, jsonb_build_object('employee_id', employee_id, 'type', type, 'title', title, 'body', body, 'payload', payload) AS r
      FROM public.notifications WHERE tenant_id = t;
  CREATE TEMP TABLE _pre_snap ON COMMIT DROP AS
    SELECT id, jsonb_build_object('employee_id', employee_id, 'sheet_id', sheet_id) AS r
      FROM public.attendance_sheet_snapshots WHERE tenant_id = t;
  CREATE TEMP TABLE _pre_chunk ON COMMIT DROP AS
    SELECT id, jsonb_build_object('document_id', document_id) AS r
      FROM public.knowledge_chunks WHERE tenant_id = t;

  -- sql/0018 forbid_hard_delete／0034 forbid_paid_bonus_mutation／0019 audit append-only
  -- 只對 status IN ('test','demo') 的租戶放行實體刪除：同一交易內切 demo → 刪 → 切回 active。
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

  -- ───────────────────────── 50-requirements.sql ─────────────────────────
  DELETE FROM overtime_settlements WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM festival_bonuses WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM birthday_gifts WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM duty_rosters WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM employee_profile_change_requests WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM disbursement_approval_steps
    WHERE (tenant_id = t
      AND disbursement_id IN (SELECT id FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%'))
      AND NOT (id = ANY(lq_keep));

  -- ───────────────────────── 30-payroll.sql ─────────────────────────
  -- 1. 憑證附件列（Storage 檔案見檔頭，另外刪）
  DELETE FROM expense_claim_attachments
    WHERE (tenant_id = t
      AND claim_id IN (SELECT id FROM expense_claims WHERE tenant_id = t AND employee_id = ANY(test_emp)))
      AND NOT (id = ANY(lq_keep));

  -- 2. 報銷單（含 settled／cancelled／rejected；綁出差單／預支的那張也在這裡一起刪）
  DELETE FROM expense_claims
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 3. 月結批次：只刪 2026-08 的【測試】月結，且沒有任何單還掛在它上面、該期也沒有真實員工的單才刪
  --    （條件式；萊乾資訊 2026-08 的測試報銷不掛月結、也不算真實員工——外層宣告的 lq）
  DELETE FROM expense_settlements s
    WHERE (s.tenant_id = t
      AND s.period = '2026-08'
      AND s.note LIKE '【測試】%'
      AND NOT EXISTS (
        SELECT 1 FROM expense_claims c
         WHERE c.tenant_id = t
           AND (c.settlement_id = s.id
                OR (c.period = '2026-08' AND NOT (c.employee_id = ANY(test_emp)) AND c.employee_id <> lq))
      ))
      AND NOT (id = ANY(lq_keep));

  -- 4. 費用類別（code test_a／test_b／test_c；'\_' 逃脫底線萬用字元）；仍被別人的單引用就保留
  DELETE FROM expense_categories cat
    WHERE (cat.tenant_id = t
      AND cat.code LIKE 'test\_%'
      AND NOT EXISTS (SELECT 1 FROM expense_claims c WHERE c.category_id = cat.id))
      AND NOT (id = ANY(lq_keep));

  -- 5. 薪資單（2026-08 三張：A finalized、B／C draft）
  DELETE FROM payslips
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 6. 調薪／薪資結構／健保眷屬／扶養親屬
  DELETE FROM salary_adjustments    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM salary_structures     WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM nhi_dependents        WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM income_tax_dependents WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 7. 非員工所得（沒有 employee_id，用受款人名稱前綴）
  DELETE FROM non_employee_income
    WHERE (tenant_id = t AND payee_name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- ───────────────────────── 20-attendance.sql ─────────────────────────
  -- 1. 通知：測試員工收到的（簽核者 A、申請人 B／C）＋ 真實 HR 收到的、payload 指向測試資料的
  DELETE FROM notifications
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep))
      AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId']));
  DELETE FROM notifications
    WHERE (tenant_id = t
      AND (
        -- 用 text 比對，避免 payload 裡不是 uuid 的值讓 ::uuid 轉型炸掉
        payload ->> 'employeeId' = ANY(test_emp::text[])
        OR payload ->> 'requestId' IN (
          SELECT id::text FROM leave_requests WHERE tenant_id = t AND employee_id = ANY(test_emp)
        )
        OR payload ->> 'sheetId' IN (
          SELECT id::text FROM attendance_sheets WHERE tenant_id = t AND employee_id = ANY(test_emp)
        )
      ))
      AND NOT (id = ANY(lq_keep))
      AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId']));

  -- 2. 預支（kind trip／petty_cash；request_id → leave_requests）
  DELETE FROM advances
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 3. 補休（含加班單核准自動記的 source_request_id 那筆）
  DELETE FROM comp_time_ledger
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 4. 附件列（Storage 檔案見檔頭，另外刪）
  DELETE FROM request_attachments
    WHERE (tenant_id = t
      AND request_id IN (SELECT id FROM leave_requests WHERE tenant_id = t AND employee_id = ANY(test_emp)))
      AND NOT (id = ANY(lq_keep));

  -- 5. 簽核關卡
  DELETE FROM approval_steps
    WHERE (tenant_id = t
      AND request_id IN (SELECT id FROM leave_requests WHERE tenant_id = t AND employee_id = ANY(test_emp)))
      AND NOT (id = ANY(lq_keep));

  -- 6. 申請單（leave／ot／fix_punch／business_trip／petty_cash，含 cancelled／rejected）
  DELETE FROM leave_requests
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 7. 假別餘額（含核准假單自動長出的 used 列，例如 C 的 test_b）
  DELETE FROM leave_balances
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 8. 月表快照（approve 時凍結的；tenant_id 無 FK，仍以 t 過濾）
  DELETE FROM attendance_sheet_snapshots
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 9. 月表逐日（sheet_id restrict → 一定要在月表之前）
  DELETE FROM attendance_sheet_days
    WHERE (tenant_id = t
      AND sheet_id IN (SELECT id FROM attendance_sheets WHERE tenant_id = t AND employee_id = ANY(test_emp)))
      AND NOT (id = ANY(lq_keep));

  -- 10. 月表（2026-08 approved ×3、2026-09 draft／submitted／manager_reviewed）
  DELETE FROM attendance_sheets
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 11. 結算結果、打卡、排班
  DELETE FROM attendance_days
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM punch_records
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM schedules
    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- ───────────────────────── 10-finance.sql ─────────────────────────
  -- 1. 獎金批次（含 paid 的【測試】獎金批次B；demo 狀態下 forbid_paid_bonus_mutation 放行）
  DELETE FROM bonus_run_items
    WHERE (tenant_id = t
      AND run_id IN (SELECT id FROM bonus_runs WHERE tenant_id = t AND label LIKE '【測試】%' AND NOT (id = ANY(lq_keep))))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM bonus_runs WHERE (tenant_id = t AND label LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- 2. 分潤異動史與成員（以【測試】專案為範圍）
  DELETE FROM project_share_adjustments
    WHERE (tenant_id = t
      AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM project_members
    WHERE (tenant_id = t
      AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))))
      AND NOT (id = ANY(lq_keep));

  -- 3. 通知：放款付清通知（給測試員工）＋ 指向【測試】專案的示警通知（給 lead 與 HR）
  DELETE FROM notifications
    WHERE (tenant_id = t AND type = 'disbursement' AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep))
      AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId']));
  DELETE FROM notifications
    WHERE (tenant_id = t AND type = 'project_alert'
      AND (payload ->> 'projectId') IN (
        SELECT id::text FROM projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))
      ))
      AND NOT (id = ANY(lq_keep))
      AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId']));

  -- 4. 放款單先退回 draft（disbursement_allocations 的 no_hard_delete_unless_draft 不看租戶狀態）
  UPDATE disbursements SET status = 'draft'
    WHERE (tenant_id = t AND purpose LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- 5. 放款附件 → 分攤 → 副委託期款 → 放款單 → 副委託
  DELETE FROM disbursement_attachments
    WHERE (tenant_id = t
      AND disbursement_id IN (SELECT id FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%'))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM disbursement_allocations
    WHERE (tenant_id = t
      AND disbursement_id IN (SELECT id FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%'))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM project_subcontract_payments
    WHERE (tenant_id = t
      AND subcontract_id IN (
        SELECT s.id FROM project_subcontracts s
          JOIN projects p ON p.id = s.project_id
         WHERE s.tenant_id = t AND p.name LIKE '【測試】%' AND NOT (p.id = ANY(lq_keep))
      ))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM disbursements WHERE (tenant_id = t AND purpose LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));
  DELETE FROM project_subcontracts
    WHERE (tenant_id = t
      AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))))
      AND NOT (id = ANY(lq_keep));

  -- 6. 期款
  DELETE FROM project_billings
    WHERE (tenant_id = t
      AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))))
      AND NOT (id = ANY(lq_keep));

  -- 7. 專案文件（在 contracts 之前：contract_id FK；Storage 檔見檔頭）
  DELETE FROM project_documents
    WHERE (tenant_id = t
      AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))))
      AND NOT (id = ANY(lq_keep));

  -- 8. 合約
  DELETE FROM contracts
    WHERE (tenant_id = t
      AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))))
      AND NOT (id = ANY(lq_keep));

  -- 9. 專案：子案先（【測試】專案A-變更 掛在 專案A 底下），再刪主案
  DELETE FROM projects
    WHERE (tenant_id = t AND name LIKE '【測試】%' AND parent_project_id IS NOT NULL)
      AND NOT (id = ANY(lq_keep));
  DELETE FROM projects
    WHERE (tenant_id = t AND name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- 10. 名冊：客戶 → 廠商 → 公司主體（預設主體永遠不碰）
  DELETE FROM clients   WHERE (tenant_id = t AND name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));
  DELETE FROM vendors   WHERE (tenant_id = t AND name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));
  DELETE FROM companies WHERE (tenant_id = t AND name LIKE '【測試】%' AND NOT is_default)
      AND NOT (id = ANY(lq_keep));

  -- ───────────────────────── 40-people.sql ─────────────────────────
  -- ── 招募 ─────────────────────────────────────────────────────────────
  DELETE FROM offers
    WHERE (tenant_id = t
      AND candidate_id IN (
        SELECT c.id FROM candidates c
          LEFT JOIN job_requisitions j ON j.id = c.requisition_id
         WHERE c.tenant_id = t AND (c.name LIKE '【測試】%' OR j.title LIKE '【測試】%')))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM interviews
    WHERE (tenant_id = t
      AND candidate_id IN (
        SELECT c.id FROM candidates c
          LEFT JOIN job_requisitions j ON j.id = c.requisition_id
         WHERE c.tenant_id = t AND (c.name LIKE '【測試】%' OR j.title LIKE '【測試】%')))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM candidates
    WHERE (tenant_id = t
      AND (name LIKE '【測試】%'
           OR requisition_id IN (SELECT id FROM job_requisitions WHERE tenant_id = t AND title LIKE '【測試】%')))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM job_requisitions WHERE (tenant_id = t AND title LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- ── 考核 ─────────────────────────────────────────────────────────────
  DELETE FROM kpi_reviews
    WHERE (tenant_id = t
      AND (employee_id = ANY(test_emp)
           OR reviewer_emp_id = ANY(test_emp)
           OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
           OR template_id IN (SELECT id FROM kpi_templates WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM kpi_templates WHERE (tenant_id = t AND name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- ── 專屬 Email 台帳 ───────────────────────────────────────────────────
  DELETE FROM employee_mailboxes
    WHERE (tenant_id = t
      AND (employee_id = ANY(test_emp)
           OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
           OR address LIKE '%@%.test.aster.local'))
      AND NOT (id = ANY(lq_keep));

  -- ── 公告（簽收 → 掃描檔 → 版本 → 公告）────────────────────────────────
  DELETE FROM announcement_acknowledgements
    WHERE (tenant_id = t
      AND (employee_id = ANY(test_emp)
           OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
           OR version_id IN (
             SELECT v.id FROM announcement_versions v
               JOIN announcements a ON a.id = v.announcement_id
              WHERE v.tenant_id = t AND a.title LIKE '【測試】%')))
      AND NOT (id = ANY(lq_keep));
  -- 掃描檔：先列出 storage_path 供 Storage 端刪除（seed 預期 0 筆）
  -- SELECT storage_path FROM announcement_signature_sheets WHERE tenant_id = t AND version_id IN (
  --   SELECT v.id FROM announcement_versions v JOIN announcements a ON a.id = v.announcement_id
  --    WHERE v.tenant_id = t AND a.title LIKE '【測試】%');
  DELETE FROM announcement_signature_sheets
    WHERE (tenant_id = t
      AND version_id IN (
        SELECT v.id FROM announcement_versions v
          JOIN announcements a ON a.id = v.announcement_id
         WHERE v.tenant_id = t AND a.title LIKE '【測試】%'))
      AND NOT (id = ANY(lq_keep));
  -- current_version_id 沒有 FK（與 versions 環狀參照），不必先清空
  DELETE FROM announcement_versions
    WHERE (tenant_id = t
      AND announcement_id IN (SELECT id FROM announcements WHERE tenant_id = t AND title LIKE '【測試】%'))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM announcements WHERE (tenant_id = t AND title LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));   -- 含已軟刪（deleted_at 不論）

  -- ── 公司資訊頁 ───────────────────────────────────────────────────────
  DELETE FROM company_pages WHERE (tenant_id = t AND title LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- ── 知識庫（chunks 已 cascade，明寫一次讓順序一目瞭然）────────────────
  DELETE FROM knowledge_chunks
    WHERE (tenant_id = t
      AND document_id IN (SELECT id FROM knowledge_documents WHERE tenant_id = t AND title LIKE '【測試】%'))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM knowledge_documents WHERE (tenant_id = t AND title LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- ── 通知（由操作自動產生，未手灌）─────────────────────────────────────
  DELETE FROM notifications
    WHERE (tenant_id = t
      AND (employee_id = ANY(test_emp)
           OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
           OR title LIKE '%【測試】%'
           OR body  LIKE '%【測試】%'))
      AND NOT (id = ANY(lq_keep))
      AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId']));

  -- ── 報到 → 報到完成產生的員工列（無登入帳號）──────────────────────────
  DELETE FROM onboardings WHERE (tenant_id = t AND name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));
  -- 只刪 user_id IS NULL 的報到者列；三位有帳號的測試員工由 00-base.sql 刪
  DELETE FROM employees
    WHERE (tenant_id = t AND name LIKE '【測試】報到者%' AND user_id IS NULL)
      AND NOT (id = ANY(lq_keep));

  -- ───────────────────────── 00-base.sql ─────────────────────────
  -- 3. 個人資料五張子表（employee_id = ANY(test_emp)）
  DELETE FROM employee_educations     WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM employee_certifications WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM employee_work_history   WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM employee_job_history    WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM employee_profiles       WHERE (tenant_id = t AND employee_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 2. 員工：先解除「測試員工A 是測試部主管」，再刪員工列
  UPDATE departments SET manager_emp_id = NULL
    WHERE (tenant_id = t AND manager_emp_id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));
  DELETE FROM employees WHERE (tenant_id = t AND id = ANY(test_emp))
      AND NOT (id = ANY(lq_keep));

  -- 1. 部門：子部門（parent 不為 null）先刪，再刪測試部 root
  DELETE FROM departments
    WHERE (tenant_id = t AND name LIKE '【測試】%' AND parent_id IS NOT NULL)
      AND NOT (id = ANY(lq_keep));
  DELETE FROM departments
    WHERE (tenant_id = t AND name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- 4. 假別（code test_a／test_b／test_c；'\_' 逃脫底線萬用字元）
  DELETE FROM leave_types WHERE (tenant_id = t AND code LIKE 'test\_%')
      AND NOT (id = ANY(lq_keep));

  -- 5. 班別
  DELETE FROM shifts WHERE (tenant_id = t AND name LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- 6. 行事曆
  DELETE FROM tenant_calendar_days WHERE (tenant_id = t AND label LIKE '【測試】%')
      AND NOT (id = ANY(lq_keep));

  -- 7. 內部連結：只濾掉 name 以【測試】開頭的，其餘原樣保留
  UPDATE tenants
    SET features = jsonb_set(
      features,
      '{internalLinks}',
      COALESCE(
        (SELECT jsonb_agg(l)
           FROM jsonb_array_elements(features -> 'internalLinks') l
          WHERE NOT (l ->> 'name' LIKE '【測試】%')),
        '[]'::jsonb
      )
    )
    WHERE id = t AND features ? 'internalLinks';

  -- 2'. auth 帳號：不在 SQL 裡刪（2026-09-30 起改用 Supabase admin API 逐一刪，GoTrue 會一併清
  --     identities／sessions）。employees.user_id 對 auth.users 沒有 FK，employees 列先刪不會被擋；
  --     要刪的帳號清單由 build.mjs 乾跑版列出（被本交易刪掉的 employees 列的 user_id）。

  UPDATE public.tenants SET status = 'active' WHERE id = t;

  -- ── 驗證：本交易刪了什麼、保護條件（乾跑一律回報；正式執行違反就整包回滾）──────────
  DECLARE
    v_counts     text;
    v_a          integer;
    v_a_detail   text;
    v_a2         integer;
    v_a2_detail  text;
    v_b          integer;
    v_b_exist    integer;
    v_c          integer;
    v_c_exist    integer;
    v_marked     text;
    v_auth       text;
    v_features   boolean;
    v_links      text;
    v_left       text;
  BEGIN
    CREATE TEMP TABLE _del ON COMMIT DROP AS
      SELECT DISTINCT ON (table_name, record_id) table_name AS tbl, record_id AS id, old_row AS r
        FROM public.audit_logs
       WHERE action = 'DELETE' AND context = 'cleanup:other-test-data' AND at >= now()
       ORDER BY table_name, record_id;
    INSERT INTO _del SELECT 'notifications', p.id, p.r FROM _pre_notif p WHERE NOT EXISTS (SELECT 1 FROM public.notifications x WHERE x.id = p.id);
    INSERT INTO _del SELECT 'attendance_sheet_snapshots', p.id, p.r FROM _pre_snap p WHERE NOT EXISTS (SELECT 1 FROM public.attendance_sheet_snapshots x WHERE x.id = p.id);
    INSERT INTO _del SELECT 'knowledge_chunks', p.id, p.r FROM _pre_chunk p WHERE NOT EXISTS (SELECT 1 FROM public.knowledge_chunks x WHERE x.id = p.id);
    SELECT string_agg(tbl || '=' || n, ' ' ORDER BY tbl) INTO v_counts FROM (SELECT tbl, count(*) n FROM _del GROUP BY tbl) x;

    -- 【測試】記號：文字欄位以【測試】開頭、code 以 test_ 開頭、屬於測試員工；通知看標題／內文含【測試】
    CREATE TEMP TABLE _cls ON COMMIT DROP AS
      SELECT d.tbl, d.id, d.r, d.r ->> 'employee_id' AS emp,
             ( EXISTS (SELECT 1 FROM jsonb_each_text(d.r) kv
                        WHERE kv.key IN ('name', 'title', 'label', 'purpose', 'payee_name', 'note', 'reason', 'description', 'school', 'company', 'file_name', 'status_reason', 'delete_reason', 'void_reason', 'location', 'comment', 'address', 'english_name', 'body', 'content', 'action', 'remark', 'dept_name', 'issuer', 'major', 'disbursement_no', 'anomaly_ack')
                          AND kv.value LIKE '【測試】%')
               OR coalesce(d.r ->> 'code', '') LIKE 'test\_%'
               OR coalesce(d.r ->> 'address', '') LIKE '%.test.aster.local'
               OR (d.r ->> 'employee_id') = ANY(test_emp::text[])
               OR (d.tbl = 'notifications' AND (coalesce(d.r ->> 'title', '') LIKE '%【測試】%' OR coalesce(d.r ->> 'body', '') LIKE '%【測試】%'))
             ) AS m0,
             false AS m1, false AS m2, NULL::text AS owner
        FROM _del d;
    -- r 裡任何 uuid（含 payload 巢狀）指到另一個被刪的列＝父列
    CREATE TEMP TABLE _ref ON COMMIT DROP AS
      SELECT DISTINCT c.id AS child, (v #>> '{}')::uuid AS parent
        FROM _cls c, LATERAL jsonb_path_query(c.r, 'strict $.**') v
       WHERE jsonb_typeof(v) = 'string'
         AND (v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND (v #>> '{}')::uuid <> c.id;
    UPDATE _cls c SET m1 = c.m0 OR EXISTS (SELECT 1 FROM _ref f JOIN _cls p ON p.id = f.parent WHERE f.child = c.id AND p.m0);
    UPDATE _cls c SET m2 = c.m1 OR EXISTS (SELECT 1 FROM _ref f JOIN _cls p ON p.id = f.parent WHERE f.child = c.id AND p.m1);
    -- 歸屬：自己的 employee_id；沒有就看被刪的父單（申請單／月表／報銷）是誰的
    UPDATE _cls c SET owner = coalesce(c.emp,
      (SELECT p.r ->> 'employee_id' FROM _ref f JOIN _cls p ON p.id = f.parent
        WHERE f.child = c.id AND p.tbl IN ('leave_requests', 'attendance_sheets', 'expense_claims') LIMIT 1));

    SELECT count(*), string_agg(DISTINCT tbl, ',') INTO v_a, v_a_detail FROM _cls
     WHERE owner IS NOT NULL AND NOT (owner = ANY(test_emp::text[])) AND NOT m2;
    SELECT count(*), string_agg(DISTINCT tbl, ',') INTO v_a2, v_a2_detail FROM _cls WHERE owner IS NULL AND NOT m2;
    SELECT string_agg(k || '=' || n, ' ' ORDER BY k) INTO v_marked FROM (
      SELECT tbl || CASE WHEN owner = lq::text THEN '(萊乾資訊)' ELSE '(真人)' END AS k, count(*) n FROM _cls
       WHERE owner IS NOT NULL AND NOT (owner = ANY(test_emp::text[])) AND m2 GROUP BY 1) x;
    SELECT count(*) INTO v_b FROM _del WHERE id = ANY(lq_keep);
    v_b_exist := (SELECT count(*) FROM unnest('{ed1d3f69-d003-5e2a-9caa-597fbe83ce23,80c16420-aa45-5ae7-924d-4d4d25f82225,6a1a8583-0a1f-58ab-88dd-02bc72940e3d,844fef13-b27b-5391-99ee-db6facebfddc,830cab1a-82a1-5174-a244-34c71f1cd0dd,ded00324-94fb-513f-b0bc-055a97638350,5e8a9b13-485e-5331-97ea-e6adb74b2199,9d07b22e-729f-53b8-a91e-4884df6c91fd,db59b70a-33ac-556b-8d35-cc167615df1f,c07d34df-9c63-57e9-8e94-41660f88efc8,5f204c71-6984-57e5-88b5-82c6911d1fdf,c4921a8a-9e2d-52df-bd62-bca6a60d613f,ec84754c-94dd-556a-8f42-532558aec58e,1f154211-8587-5860-b63d-5f4a91eb9f2d,ddd9c602-2b7c-55c3-abe9-c433cfca878d,26d4b581-f407-5b3e-a5d8-f82f5aaaf14f,031838a0-94bd-5bea-9626-cbac0fb3c9b3,4146aea2-e9c3-5623-8097-f1975d0c99ba,c1e39026-9efe-5173-b7d1-0e49a7c51d2b,c4319de1-b041-50dc-ad54-0565f0d2e6c4,9d9c40a5-3a02-53bc-af6c-e658e628b56f}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.schedules y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{b9bc27e0-62eb-5718-b8d2-b1b4e3fde044,b683b8d8-d100-54e5-ab3f-dc7225115611,4db7d0c8-be8d-5bdb-a722-7ea6ea2a96fc,b67a8de0-70ed-5f6d-9a49-7e1ae97caa30,55454070-0b69-55ca-baf5-9996b99aa090,3c19d6d3-09b1-572b-8cef-6098dcdd5d65,51fc8c73-cbec-5a53-83b9-7ec42fe9ef30,32a484c1-29d9-569c-8065-4b8c63f43a20,1553c253-ca80-5f6e-b6f5-d0a579484411,e148c5ee-e7a8-5318-8f0f-1a855002221d,ce17385b-c80c-5bbb-aa75-f42f946ba37f,e676d24d-4de9-54de-ae57-b2d9cb3d7ae6,6aa5505c-7bf9-5a3e-9b01-0603ef4a4f99,485f53dc-0c65-59a2-8d8c-fdd095c9ec9b,0260c213-4914-51b6-a584-3128405aef6b,6c5a7644-e8e7-5901-89b8-ae94bb22b18f,6690e3b4-9965-50fb-8ed9-b9cc1d718953,054643f9-8527-58dc-a775-752fc6fa14eb,8cf6b6c2-016b-5441-bf40-d033b8a77718,c8fe8237-2801-546e-899b-9ec7c4acf9bb,bae81980-57fa-530e-9d28-47516b3645f1,f1014174-89aa-5af1-80e9-e6f2e5677010,0134a98e-4f4c-55d5-9a54-8861bb4671f7,198fc7b1-a813-50c5-af38-23b08ce6f8b3,ee5a1e9b-95ba-5fb6-a05c-763812fd728d,3a4b89aa-6283-5d81-a61e-760fc4f219da,6d0c87de-e4e8-5660-97bb-2eb266b9f7ab,ca51e278-e664-54d6-ae78-75d6e3cc932f,925c90f6-6318-5acf-9880-cc8d0c30f2a3,70d5f629-86fe-58d6-b3d1-1b93654bc22e,0f414ef8-9205-533a-95a8-000c2a25b626,dd825f3a-328e-5bbf-8f66-e6a071005aba,329e8945-4b8e-5e29-959b-e7897a8652f1,075914e2-a411-57cd-adbf-221b54f6eea3,c854683c-6a52-5212-b939-32766a2ad157,8f9e841c-8b9d-579f-9ba1-6cef19d927c9,ae153b60-fcd3-56f2-8ae9-28cb5c43caeb,a307792d-7871-5419-83ca-704ba7acea06}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.punch_records y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{40ba9b03-fba2-568a-bd0a-1f8820e040b6,17ff4ab1-2e60-5efe-94c5-baa66578a3e6,f03fde04-4605-52a0-8c3e-36414dfa61fe,e62fedad-d987-5a61-807f-3162642daf5e,3334918f-66b1-530c-bca8-d3b45838b5fe,463c82b9-e24e-50b3-b8f2-9eccfe3c3175,94d92d28-f742-5870-abdb-a157a8545976,d8a18604-ca59-5e4b-8cb0-d2ccf0c458f3,fa913fc3-6752-505d-b211-d7707615f090,50ea1cd8-c0f9-57f7-8a05-2a59afdf996a,6c5ddd02-0bb6-584d-a193-9489adb38a3d,647cc8f9-a39d-569c-8b85-32445c68b871,4918702b-c8be-5c98-910a-1ba8001a2277,27053b17-ed1c-5657-8832-79fef6024486,25e4b80a-db8e-54db-adfa-3eb5b84b0a6d,c0b4052d-e56c-58de-b5c7-bd3b05de802b,66658949-4282-5e1b-a640-112580ca7b1e,d07ff53e-7842-561c-a3ca-201040f67317,465e6974-e133-544f-8027-9d0ebc66bd51,fe812890-9ebf-5972-a7b7-0956c3f93aab,16967ffd-d704-53cd-b8fa-698bd54bc256,26fc23c3-5e4e-538b-aa74-67d8544d05be}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.leave_requests y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{4e8377b3-7367-523c-8633-fcc06e3c6278,3c1109e6-e84b-5baf-a7e1-f8904a7ed6e3,6fd69a35-4319-55fd-b787-fc2e15c9ddba,a3781fab-ab1f-54b5-bd02-b2b9f149a603,4507f9aa-2b33-59c8-84f0-23d9bd259d3f,db0f85f4-92e5-5f40-95f1-b6893e826a4c,1117f1a4-7c9d-5a6b-831c-97c41a40fc5a,3838961b-ac62-582f-bf50-64b757bec9b7,6903a818-8cba-5662-9603-c041e461d01f,b6ba3ca5-6d17-5a29-a422-21337dbd1a30,d5fab93f-5042-56db-952b-2a89efe679ee,3c6d446e-671c-56d6-938e-e23d4240a0fe,ede1d755-a998-53c1-a0bd-5d1d16139f30,fc7089f7-45d5-50ac-9c05-1cfdea23c0cc,86f63300-553c-53bd-b27b-2846bf113be5,edd0572e-aa98-511f-b90b-ad4b6d40cdb8,f4373dae-dad6-5a3a-8484-5fbea7e2c3ab,136ea37a-57ff-575f-8b9d-570d7dd11d9c,f1d392ac-2ed7-529c-a0be-cb778bfcd516,eb419ae7-588a-5e45-94c2-a433636c3ef9,3cf87001-9317-5834-87a8-a150f5838837,3238f487-59da-5373-8d5e-ff7db434b774}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.approval_steps y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{72c52899-3a1c-5a82-9fde-e168cc6a40cb}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.comp_time_ledger y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{8c8d6480-3265-55cb-8e10-2b1a6c8d71e7,7aa62227-4d75-5cae-9213-8ef1e7df3ec1}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.advances y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{28c51f55-416d-58d5-89e4-4255d60f8d7e,c3860ddb-5062-5a6e-8be6-50b03d4f4758,1ccd3e23-27b6-58a5-87f3-c9866fda67fb,3c41c4c5-3553-59f3-a25e-8e4a678cd50e}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.leave_balances y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{829efd15-7de9-54b2-bab8-48f354cb344d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.payslips y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{ed24f19c-40e9-558a-aef2-1713ddf45a94,2143e163-085f-5d94-b39c-4e288642fc57,3b1ae296-01b4-5067-b44e-346422f490e0,e622a5e7-5c24-55eb-abdd-8a1d47c4f30d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.expense_claims y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{c2199bb5-03d3-5a33-af3e-8913ee026750}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.kpi_templates y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{34cc6074-e4c0-5195-87c7-8b857d76c8eb}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.kpi_reviews y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{324f8933-a7d9-5684-a582-fcdecfd6a5c5}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.projects y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{096be1e2-9684-56cd-a958-fc96f8180edf}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.project_members y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{93e67f24-f822-5802-8805-67a330062996}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.bonus_runs y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{68c980d7-0b43-5f26-9125-33eb21e9c487}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.bonus_run_items y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{3547b847-3d1a-50bf-91f8-68dbb27e6c5a}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_profiles y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{a96d296f-6a98-5198-9c41-44945243f75d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_educations y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{01647e0e-6158-56d0-ba57-a84e254e8dc5}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_certifications y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{1cfa5934-f892-5c7f-a6f0-2fc6dc699eeb}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_work_history y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{152d1926-b11d-5004-8f8f-dbe9ba0681e9}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_job_history y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{5d6e7229-47e4-5fab-8b05-dea7935607c5,aba6fba5-8b7a-593b-88a3-b9898220dd84,5ce6dcbd-6d8d-50d7-bb97-a7c324d2d404,bdb3a819-043a-5b99-8d42-a9c04bdf7b08}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.notifications y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{ef2102b0-0626-4359-a7dc-1f74814fab40}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.attendance_sheets y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{5475da86-f2b9-4ef5-990a-9e97c24f7ab4,b60e55ba-3064-4cbb-9391-b3632a1ee2db,ed21cb8c-2860-421a-9237-79e1f18920a0,d09fd061-ad19-404c-842f-715cbc07400b,f1342e48-25ac-4e8b-8e2e-a6e3cacfb880,87619787-6ad8-49fe-9e6b-40cb5971023e,0c8d1d89-e76f-42b7-b5d9-01880a24c16b,ec6c091b-87a6-4142-99b8-ee9a3261d822,a75a4547-c81c-4e13-a6ca-659e98c9e4e8,56777b4c-549c-4d67-acea-85b9679f7b7f,42efcee9-8b75-4a67-9331-a5b3d2a800a3,67941ed6-8251-4f54-b321-757632a4905d,b2e0a997-7073-4fb4-8e19-0f8579c26fdd,d355745d-00e3-44b3-aac7-023e1191336f,e78d45ac-499a-4a48-b0ae-0afea5a5ccd2,2cc255e8-4213-4661-90e6-4fd271500bbf,a4a22676-318c-48f0-a577-d913e688cf4c,83feb7ff-5fe2-4279-9d7b-31f66d2b221f,79f8c347-76ea-4d97-afb9-399ecabe938c,ef09d84e-3aa2-47fa-b336-9342a08ca911,f3d16301-2eeb-4f84-84fb-ba16b92940e3,e823fad2-a122-4d5b-9106-a71714cc120b,e6dadf67-9ed9-4661-a620-bb34a26cfd64,96caed30-570f-4648-8025-cc9091d840c9,9dcccf9d-9f2c-4c62-ab2e-f94dba00c3bc,eec0c5ee-69e6-45c3-9414-5e405160de7f,b7d1b0ef-ba44-406d-bfe2-cef746635250,63e90d4e-f9e6-4fab-9b90-9821a4df5e65,5d639e01-5bf0-4fed-82df-f0ade8f1c362,3d5a4286-1622-4196-a063-d849f4a765de,d3d7bac5-3fb0-4024-b3a5-57d00557a375}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.attendance_sheet_days y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{283cca9d-d319-4a36-be6b-1ec291bbd920,149fc5d5-b031-4688-a13e-7b3cadef7e09,67790939-3384-4deb-9703-3ea008c1bb0e,bb4deac5-6d1b-4fce-bf7c-5bbfa6a26acf,36a1df4b-2b27-4faf-9829-e007551a76ab,d6128fbc-1784-4539-b69a-3dec16e7b899,47cccf8a-1a17-4a79-a202-c244a135f732,43015db5-2934-4fd9-af99-1dd769fe7d30,f0ae4d63-2725-4df0-bede-0033f31b10c7,153fbc9e-4940-4458-a104-a83137ed0780,a16cb8ac-14de-48e3-8678-52f10581c724,2a412e62-bb53-4e9a-bc30-3bc9cd6b7507,d54942b2-dae5-4092-a671-23d0311d2305,9269eff6-de1c-4ca9-9693-8d48fe7a84f0,c6eebdf8-75b7-4284-9f23-98c96a7e1ae8,3b763660-8fa8-4a05-8229-01fd3ef8a4fd,77c97ce2-1f62-4151-884f-3654de291e47,f3a3b217-88bf-4f13-a897-14be08ae2f62,360be0e6-96e7-4d73-b8d1-9b78f85faf85,36c0d2c1-567e-47f4-9326-4bcc64cdb1d1,aac0ff18-a4ca-43f1-b055-d416bc1ae45a}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.attendance_days y WHERE y.id = x.id))
        + (SELECT CASE WHEN EXISTS (SELECT 1 FROM public.employees WHERE tenant_id = t AND id = lq AND status = 'active') THEN 0 ELSE 1 END);
    -- (c) 測試同仁 B：保留項目（員工列／部門／特休列）＋ B 在 manifest 的單／關卡／事假額度＋ auth 帳號
    SELECT count(*) INTO v_c FROM _del WHERE id = ANY('{6d7ceda1-d5c8-411c-80d1-841b5ccbf96d,66091721-b4e7-4c61-9033-05fe76e0e135,3241aaf3-f758-467f-bc6c-aad36f215e5d,fe812890-9ebf-5972-a7b7-0956c3f93aab,16967ffd-d704-53cd-b8fa-698bd54bc256,26fc23c3-5e4e-538b-aa74-67d8544d05be,eb419ae7-588a-5e45-94c2-a433636c3ef9,3cf87001-9317-5834-87a8-a150f5838837,3238f487-59da-5373-8d5e-ff7db434b774,3c41c4c5-3553-59f3-a25e-8e4a678cd50e}'::uuid[]);
    v_c_exist := (SELECT count(*) FROM unnest('{6d7ceda1-d5c8-411c-80d1-841b5ccbf96d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employees y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{66091721-b4e7-4c61-9033-05fe76e0e135}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.departments y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{3241aaf3-f758-467f-bc6c-aad36f215e5d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.leave_balances y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{fe812890-9ebf-5972-a7b7-0956c3f93aab,16967ffd-d704-53cd-b8fa-698bd54bc256,26fc23c3-5e4e-538b-aa74-67d8544d05be}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.leave_requests y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{eb419ae7-588a-5e45-94c2-a433636c3ef9,3cf87001-9317-5834-87a8-a150f5838837,3238f487-59da-5373-8d5e-ff7db434b774}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.approval_steps y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{3c41c4c5-3553-59f3-a25e-8e4a678cd50e}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.leave_balances y WHERE y.id = x.id))
        + (SELECT CASE WHEN EXISTS (SELECT 1 FROM public.employees WHERE tenant_id = t AND id = '6d7ceda1-d5c8-411c-80d1-841b5ccbf96d' AND status = 'active') THEN 0 ELSE 1 END)
        + (SELECT CASE WHEN EXISTS (SELECT 1 FROM auth.users WHERE id = '5082c7a0-2005-446d-9e03-cd6bb12782d4') THEN 0 ELSE 1 END);

    SELECT string_agg((d.r ->> 'user_id') || '＠' || coalesce(split_part(u.email, '@', 2), '（auth 無此帳號）'), ' ' ORDER BY d.r ->> 'user_id') INTO v_auth
      FROM _del d LEFT JOIN auth.users u ON u.id = (d.r ->> 'user_id')::uuid
     WHERE d.tbl = 'employees' AND d.r ->> 'user_id' IS NOT NULL;
    IF coalesce(v_auth, '') LIKE '%5082c7a0-2005-446d-9e03-cd6bb12782d4%' THEN v_c := v_c + 1; END IF;
    SELECT (f_before - 'internalLinks') = (features - 'internalLinks'),
           jsonb_array_length(coalesce(f_before -> 'internalLinks', '[]')) || '→' || jsonb_array_length(coalesce(features -> 'internalLinks', '[]'))
      INTO v_features, v_links FROM public.tenants WHERE id = t;

    SELECT string_agg(k || '=' || v, ' ') INTO v_left FROM (
      SELECT 'test_employees_outside_keep' k, count(*)::text v FROM public.employees WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))
      UNION ALL SELECT 'test_like_rows_outside_lq', (
          (SELECT count(*) FROM public.departments WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%')
        + (SELECT count(*) FROM public.bonus_runs WHERE tenant_id = t AND label LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.clients WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.vendors WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.companies WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.announcements WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.company_pages WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.job_requisitions WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.knowledge_documents WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.kpi_templates WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.leave_types WHERE tenant_id = t AND code LIKE 'test\_%')
        + (SELECT count(*) FROM public.shifts WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.expense_categories WHERE tenant_id = t AND code LIKE 'test\_%')
        + (SELECT count(*) FROM public.expense_settlements WHERE tenant_id = t AND note LIKE '【測試】%')
        + (SELECT count(*) FROM public.tenant_calendar_days WHERE tenant_id = t AND label LIKE '【測試】%')
        + (SELECT count(*) FROM public.notifications WHERE tenant_id = t AND (title LIKE '%【測試】%' OR body LIKE '%【測試】%') AND NOT (id = ANY(lq_keep))
             AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId'])))
        + (SELECT count(*) FROM public.leave_requests WHERE tenant_id = t AND reason LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
      )::text
      UNION ALL SELECT 'test_internal_links', (SELECT count(*) FROM public.tenants, jsonb_array_elements(coalesce(features -> 'internalLinks', '[]')) l WHERE id = t AND l ->> 'name' LIKE '【測試】%')::text
      UNION ALL SELECT 'lq_manifest_rows_present', (183 - ((SELECT count(*) FROM unnest('{ed1d3f69-d003-5e2a-9caa-597fbe83ce23,80c16420-aa45-5ae7-924d-4d4d25f82225,6a1a8583-0a1f-58ab-88dd-02bc72940e3d,844fef13-b27b-5391-99ee-db6facebfddc,830cab1a-82a1-5174-a244-34c71f1cd0dd,ded00324-94fb-513f-b0bc-055a97638350,5e8a9b13-485e-5331-97ea-e6adb74b2199,9d07b22e-729f-53b8-a91e-4884df6c91fd,db59b70a-33ac-556b-8d35-cc167615df1f,c07d34df-9c63-57e9-8e94-41660f88efc8,5f204c71-6984-57e5-88b5-82c6911d1fdf,c4921a8a-9e2d-52df-bd62-bca6a60d613f,ec84754c-94dd-556a-8f42-532558aec58e,1f154211-8587-5860-b63d-5f4a91eb9f2d,ddd9c602-2b7c-55c3-abe9-c433cfca878d,26d4b581-f407-5b3e-a5d8-f82f5aaaf14f,031838a0-94bd-5bea-9626-cbac0fb3c9b3,4146aea2-e9c3-5623-8097-f1975d0c99ba,c1e39026-9efe-5173-b7d1-0e49a7c51d2b,c4319de1-b041-50dc-ad54-0565f0d2e6c4,9d9c40a5-3a02-53bc-af6c-e658e628b56f}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.schedules y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{b9bc27e0-62eb-5718-b8d2-b1b4e3fde044,b683b8d8-d100-54e5-ab3f-dc7225115611,4db7d0c8-be8d-5bdb-a722-7ea6ea2a96fc,b67a8de0-70ed-5f6d-9a49-7e1ae97caa30,55454070-0b69-55ca-baf5-9996b99aa090,3c19d6d3-09b1-572b-8cef-6098dcdd5d65,51fc8c73-cbec-5a53-83b9-7ec42fe9ef30,32a484c1-29d9-569c-8065-4b8c63f43a20,1553c253-ca80-5f6e-b6f5-d0a579484411,e148c5ee-e7a8-5318-8f0f-1a855002221d,ce17385b-c80c-5bbb-aa75-f42f946ba37f,e676d24d-4de9-54de-ae57-b2d9cb3d7ae6,6aa5505c-7bf9-5a3e-9b01-0603ef4a4f99,485f53dc-0c65-59a2-8d8c-fdd095c9ec9b,0260c213-4914-51b6-a584-3128405aef6b,6c5a7644-e8e7-5901-89b8-ae94bb22b18f,6690e3b4-9965-50fb-8ed9-b9cc1d718953,054643f9-8527-58dc-a775-752fc6fa14eb,8cf6b6c2-016b-5441-bf40-d033b8a77718,c8fe8237-2801-546e-899b-9ec7c4acf9bb,bae81980-57fa-530e-9d28-47516b3645f1,f1014174-89aa-5af1-80e9-e6f2e5677010,0134a98e-4f4c-55d5-9a54-8861bb4671f7,198fc7b1-a813-50c5-af38-23b08ce6f8b3,ee5a1e9b-95ba-5fb6-a05c-763812fd728d,3a4b89aa-6283-5d81-a61e-760fc4f219da,6d0c87de-e4e8-5660-97bb-2eb266b9f7ab,ca51e278-e664-54d6-ae78-75d6e3cc932f,925c90f6-6318-5acf-9880-cc8d0c30f2a3,70d5f629-86fe-58d6-b3d1-1b93654bc22e,0f414ef8-9205-533a-95a8-000c2a25b626,dd825f3a-328e-5bbf-8f66-e6a071005aba,329e8945-4b8e-5e29-959b-e7897a8652f1,075914e2-a411-57cd-adbf-221b54f6eea3,c854683c-6a52-5212-b939-32766a2ad157,8f9e841c-8b9d-579f-9ba1-6cef19d927c9,ae153b60-fcd3-56f2-8ae9-28cb5c43caeb,a307792d-7871-5419-83ca-704ba7acea06}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.punch_records y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{40ba9b03-fba2-568a-bd0a-1f8820e040b6,17ff4ab1-2e60-5efe-94c5-baa66578a3e6,f03fde04-4605-52a0-8c3e-36414dfa61fe,e62fedad-d987-5a61-807f-3162642daf5e,3334918f-66b1-530c-bca8-d3b45838b5fe,463c82b9-e24e-50b3-b8f2-9eccfe3c3175,94d92d28-f742-5870-abdb-a157a8545976,d8a18604-ca59-5e4b-8cb0-d2ccf0c458f3,fa913fc3-6752-505d-b211-d7707615f090,50ea1cd8-c0f9-57f7-8a05-2a59afdf996a,6c5ddd02-0bb6-584d-a193-9489adb38a3d,647cc8f9-a39d-569c-8b85-32445c68b871,4918702b-c8be-5c98-910a-1ba8001a2277,27053b17-ed1c-5657-8832-79fef6024486,25e4b80a-db8e-54db-adfa-3eb5b84b0a6d,c0b4052d-e56c-58de-b5c7-bd3b05de802b,66658949-4282-5e1b-a640-112580ca7b1e,d07ff53e-7842-561c-a3ca-201040f67317,465e6974-e133-544f-8027-9d0ebc66bd51,fe812890-9ebf-5972-a7b7-0956c3f93aab,16967ffd-d704-53cd-b8fa-698bd54bc256,26fc23c3-5e4e-538b-aa74-67d8544d05be}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.leave_requests y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{4e8377b3-7367-523c-8633-fcc06e3c6278,3c1109e6-e84b-5baf-a7e1-f8904a7ed6e3,6fd69a35-4319-55fd-b787-fc2e15c9ddba,a3781fab-ab1f-54b5-bd02-b2b9f149a603,4507f9aa-2b33-59c8-84f0-23d9bd259d3f,db0f85f4-92e5-5f40-95f1-b6893e826a4c,1117f1a4-7c9d-5a6b-831c-97c41a40fc5a,3838961b-ac62-582f-bf50-64b757bec9b7,6903a818-8cba-5662-9603-c041e461d01f,b6ba3ca5-6d17-5a29-a422-21337dbd1a30,d5fab93f-5042-56db-952b-2a89efe679ee,3c6d446e-671c-56d6-938e-e23d4240a0fe,ede1d755-a998-53c1-a0bd-5d1d16139f30,fc7089f7-45d5-50ac-9c05-1cfdea23c0cc,86f63300-553c-53bd-b27b-2846bf113be5,edd0572e-aa98-511f-b90b-ad4b6d40cdb8,f4373dae-dad6-5a3a-8484-5fbea7e2c3ab,136ea37a-57ff-575f-8b9d-570d7dd11d9c,f1d392ac-2ed7-529c-a0be-cb778bfcd516,eb419ae7-588a-5e45-94c2-a433636c3ef9,3cf87001-9317-5834-87a8-a150f5838837,3238f487-59da-5373-8d5e-ff7db434b774}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.approval_steps y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{72c52899-3a1c-5a82-9fde-e168cc6a40cb}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.comp_time_ledger y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{8c8d6480-3265-55cb-8e10-2b1a6c8d71e7,7aa62227-4d75-5cae-9213-8ef1e7df3ec1}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.advances y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{28c51f55-416d-58d5-89e4-4255d60f8d7e,c3860ddb-5062-5a6e-8be6-50b03d4f4758,1ccd3e23-27b6-58a5-87f3-c9866fda67fb,3c41c4c5-3553-59f3-a25e-8e4a678cd50e}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.leave_balances y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{829efd15-7de9-54b2-bab8-48f354cb344d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.payslips y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{ed24f19c-40e9-558a-aef2-1713ddf45a94,2143e163-085f-5d94-b39c-4e288642fc57,3b1ae296-01b4-5067-b44e-346422f490e0,e622a5e7-5c24-55eb-abdd-8a1d47c4f30d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.expense_claims y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{c2199bb5-03d3-5a33-af3e-8913ee026750}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.kpi_templates y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{34cc6074-e4c0-5195-87c7-8b857d76c8eb}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.kpi_reviews y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{324f8933-a7d9-5684-a582-fcdecfd6a5c5}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.projects y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{096be1e2-9684-56cd-a958-fc96f8180edf}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.project_members y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{93e67f24-f822-5802-8805-67a330062996}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.bonus_runs y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{68c980d7-0b43-5f26-9125-33eb21e9c487}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.bonus_run_items y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{3547b847-3d1a-50bf-91f8-68dbb27e6c5a}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_profiles y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{a96d296f-6a98-5198-9c41-44945243f75d}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_educations y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{01647e0e-6158-56d0-ba57-a84e254e8dc5}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_certifications y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{1cfa5934-f892-5c7f-a6f0-2fc6dc699eeb}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_work_history y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{152d1926-b11d-5004-8f8f-dbe9ba0681e9}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.employee_job_history y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{5d6e7229-47e4-5fab-8b05-dea7935607c5,aba6fba5-8b7a-593b-88a3-b9898220dd84,5ce6dcbd-6d8d-50d7-bb97-a7c324d2d404,bdb3a819-043a-5b99-8d42-a9c04bdf7b08}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.notifications y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{ef2102b0-0626-4359-a7dc-1f74814fab40}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.attendance_sheets y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{5475da86-f2b9-4ef5-990a-9e97c24f7ab4,b60e55ba-3064-4cbb-9391-b3632a1ee2db,ed21cb8c-2860-421a-9237-79e1f18920a0,d09fd061-ad19-404c-842f-715cbc07400b,f1342e48-25ac-4e8b-8e2e-a6e3cacfb880,87619787-6ad8-49fe-9e6b-40cb5971023e,0c8d1d89-e76f-42b7-b5d9-01880a24c16b,ec6c091b-87a6-4142-99b8-ee9a3261d822,a75a4547-c81c-4e13-a6ca-659e98c9e4e8,56777b4c-549c-4d67-acea-85b9679f7b7f,42efcee9-8b75-4a67-9331-a5b3d2a800a3,67941ed6-8251-4f54-b321-757632a4905d,b2e0a997-7073-4fb4-8e19-0f8579c26fdd,d355745d-00e3-44b3-aac7-023e1191336f,e78d45ac-499a-4a48-b0ae-0afea5a5ccd2,2cc255e8-4213-4661-90e6-4fd271500bbf,a4a22676-318c-48f0-a577-d913e688cf4c,83feb7ff-5fe2-4279-9d7b-31f66d2b221f,79f8c347-76ea-4d97-afb9-399ecabe938c,ef09d84e-3aa2-47fa-b336-9342a08ca911,f3d16301-2eeb-4f84-84fb-ba16b92940e3,e823fad2-a122-4d5b-9106-a71714cc120b,e6dadf67-9ed9-4661-a620-bb34a26cfd64,96caed30-570f-4648-8025-cc9091d840c9,9dcccf9d-9f2c-4c62-ab2e-f94dba00c3bc,eec0c5ee-69e6-45c3-9414-5e405160de7f,b7d1b0ef-ba44-406d-bfe2-cef746635250,63e90d4e-f9e6-4fab-9b90-9821a4df5e65,5d639e01-5bf0-4fed-82df-f0ade8f1c362,3d5a4286-1622-4196-a063-d849f4a765de,d3d7bac5-3fb0-4024-b3a5-57d00557a375}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.attendance_sheet_days y WHERE y.id = x.id))
        + (SELECT count(*) FROM unnest('{283cca9d-d319-4a36-be6b-1ec291bbd920,149fc5d5-b031-4688-a13e-7b3cadef7e09,67790939-3384-4deb-9703-3ea008c1bb0e,bb4deac5-6d1b-4fce-bf7c-5bbfa6a26acf,36a1df4b-2b27-4faf-9829-e007551a76ab,d6128fbc-1784-4539-b69a-3dec16e7b899,47cccf8a-1a17-4a79-a202-c244a135f732,43015db5-2934-4fd9-af99-1dd769fe7d30,f0ae4d63-2725-4df0-bede-0033f31b10c7,153fbc9e-4940-4458-a104-a83137ed0780,a16cb8ac-14de-48e3-8678-52f10581c724,2a412e62-bb53-4e9a-bc30-3bc9cd6b7507,d54942b2-dae5-4092-a671-23d0311d2305,9269eff6-de1c-4ca9-9693-8d48fe7a84f0,c6eebdf8-75b7-4284-9f23-98c96a7e1ae8,3b763660-8fa8-4a05-8229-01fd3ef8a4fd,77c97ce2-1f62-4151-884f-3654de291e47,f3a3b217-88bf-4f13-a897-14be08ae2f62,360be0e6-96e7-4d73-b8d1-9b78f85faf85,36c0d2c1-567e-47f4-9326-4bcc64cdb1d1,aac0ff18-a4ca-43f1-b055-d416bc1ae45a}'::uuid[]) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.attendance_days y WHERE y.id = x.id))))::text || '/183'
      UNION ALL SELECT 'colleague_rows_missing', v_c_exist::text || '（共 11 項）'
      UNION ALL SELECT 'real_employees', count(*)::text FROM public.employees WHERE tenant_id = t AND name NOT LIKE '【測試】%'
    ) x;

    IF v_a > 0 OR v_a2 > 0 OR v_b > 0 OR v_b_exist > 0 OR v_c > 0 OR v_c_exist > 0 OR NOT v_features THEN
      RAISE EXCEPTION 'PROTECTION_VIOLATION（整包回滾）(a)=% [%] (a2)=% [%] (b)=%/% (c)=%/% features_ok=%', v_a, v_a_detail, v_a2, v_a2_detail, v_b, v_b_exist, v_c, v_c_exist, v_features;
    END IF;
    RAISE NOTICE 'deleted: % | 非測試員工但有記號: % | internalLinks % | 待 admin API 刪的 auth 帳號: % | 剩餘: %', v_counts, v_marked, v_links, v_auth, v_left;
  END;
END $$;
