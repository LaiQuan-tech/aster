-- =====================================================================
-- 0037  稽核孤兒列一勞永逸 ＋ 測試租戶一鍵清除
--
-- (1) forbid_audit_mutation：對「租戶列已不存在」的稽核列放行 DELETE。
--     tenants 自己掛著 audit_all（sql/0031），刪租戶那一刻就會寫下一筆 tenant_id 指向
--     已消失租戶的稽核列——它天生是孤兒，任何清理順序都救不了；而 0019 的規則是
--     「租戶查不到 → 不是 disposable → 擋」，所以這些列只有 owner 停 trigger 才刪得掉
--     （09-15 累到 17,206 列、09-20 累到 20,811 列）。
--     放行條件只有一個：tenants 裡查不到這個 tenant_id。正式租戶不可能被實體刪除
--     （sql/0018 no_hard_delete 對 active 租戶一律擋），所以落到這個條件的只會是
--     test/demo 租戶留下的列。UPDATE 照舊全擋；tenant_id 為 null 的系統列照舊全擋。
--
-- (2) purge_test_tenant(uuid)：把一個 test/demo 租戶連同它在**每一張**有 tenant_id 的
--     表裡的資料整個刪掉，最後連 tenants 列與它刪除時寫下的稽核列一起清。
--     整合測試各自手寫的 afterAll 只刪自己知道的幾張表，新表（月表快照、公告版本、
--     結帳…）一加就開始漏，FK 擋住 → 租戶刪不掉 → 正式庫累積 test 租戶（09-20 有 10 個）。
--     這支從 information_schema 動態列出所有有 tenant_id 的表，FK 擋住的下一輪再試，
--     不需要知道表之間的順序，新表自動涵蓋。**只接受 status IN ('test','demo')**，
--     正式租戶一律 RAISE。Storage 物件與 auth.users 不在這裡（呼叫端用 Storage / GoTrue admin API）。
--     只 GRANT 給 service_role。
-- 冪等，可重複執行。
-- =====================================================================

-- ── (1) 稽核列：租戶已不存在 → 放行 DELETE ──────────────────────────
CREATE OR REPLACE FUNCTION public.forbid_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 同 0018：僅 test/demo 租戶放行，供整合測試清理。
  IF public.is_disposable_tenant(OLD.tenant_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- 0037：租戶列已不存在的孤兒稽核列，放行 DELETE（正式租戶不可能被實體刪除，
  -- 能走到這裡的只有 test/demo 租戶刪掉後留下的列）。UPDATE 仍然全擋。
  IF TG_OP = 'DELETE'
     AND OLD.tenant_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'audit_logs 為 append-only，不可 % （可改可刪的稽核軌跡等於沒有）。', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ── (2) 測試租戶一鍵清除 ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_test_tenant(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_status   text;
  v_deleted  jsonb := '{}'::jsonb;
  v_count    bigint;
  v_blocked  int;
  v_pass     int := 0;
  v_last_err text := null;
  r          record;
BEGIN
  SELECT status INTO v_status FROM public.tenants WHERE id = p_tenant;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'purge_test_tenant: 租戶 % 不存在', p_tenant USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status NOT IN ('test', 'demo') THEN
    RAISE EXCEPTION 'purge_test_tenant: 租戶 % 是 %，只能清 test/demo 租戶', p_tenant, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 每一輪對所有有 tenant_id 的表各刪一次；被 FK 擋住的（子表還沒刪）下一輪再來。
  -- 表數 ~70、最多 10 輪，測試租戶資料量小，秒級。
  LOOP
    v_pass := v_pass + 1;
    v_blocked := 0;
    FOR r IN
      SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
         AND t.table_type = 'BASE TABLE' AND c.table_name <> 'tenants'
       ORDER BY c.table_name
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE tenant_id = $1', r.table_name) USING p_tenant;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        IF v_count > 0 THEN
          v_deleted := v_deleted || jsonb_build_object(
            r.table_name, coalesce((v_deleted ->> r.table_name)::bigint, 0) + v_count);
        END IF;
      EXCEPTION
        WHEN foreign_key_violation THEN
          v_blocked := v_blocked + 1;
          v_last_err := r.table_name || ': ' || SQLERRM;
      END;
    END LOOP;
    EXIT WHEN v_blocked = 0 OR v_pass >= 10;
  END LOOP;
  IF v_blocked > 0 THEN
    RAISE EXCEPTION 'purge_test_tenant: 跑了 % 輪仍有 % 張表被 FK 擋住（最後一個：%）', v_pass, v_blocked, v_last_err;
  END IF;

  DELETE FROM public.tenants WHERE id = p_tenant;
  -- 上面每一個 DELETE 都被 audit_all 記了一筆（含刪租戶那一筆），此時租戶已不存在，
  -- 由 (1) 放行，一次清乾淨。
  DELETE FROM public.audit_logs WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('tenant', p_tenant, 'status', v_status, 'passes', v_pass,
                            'deleted', v_deleted, 'auditRowsAfter', v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.purge_test_tenant(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_test_tenant(uuid) TO service_role;
COMMENT ON FUNCTION public.purge_test_tenant(uuid) IS
  '只給 service_role：把 status=test/demo 的租戶連同所有有 tenant_id 的表的資料、租戶列、稽核列整個刪除。正式租戶一律 RAISE。整合測試 afterAll 與清理殘留測試租戶用。';
