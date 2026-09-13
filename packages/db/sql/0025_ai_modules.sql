-- =====================================================================
-- 0025  AI 模組地基：RLS、向量索引、相似度查詢函式、bucket
--       （配合 migration 0037：company_pages、employee_mailboxes、vendors、
--        knowledge_documents、knowledge_chunks，projects.starts_on/ends_on）
--
-- 前提：migration 0037 已套（含 pgvector extension）。
-- 冪等，可重複執行。
-- =====================================================================

-- ── RLS：全部是 API 專用表，比照 sql/0024——啟用、不給 policy ──────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_pages', 'employee_mailboxes', 'vendors', 'knowledge_documents', 'knowledge_chunks'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── 稽核：廠商名冊與信箱台帳是往來／配發紀錄，留痕 ─────────────────────
DROP TRIGGER IF EXISTS audit_all ON public.vendors;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS audit_all ON public.employee_mailboxes;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_mailboxes
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS no_hard_delete ON public.vendors;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

-- ── 向量索引：HNSW + cosine（資料量小到中等都合適；建立不需事先有資料）──
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw
  ON public.knowledge_chunks USING hnsw (embedding extensions.vector_cosine_ops);

-- ── 相似度查詢：API 以 service_role 呼叫（rpc），租戶隔離在參數層 ───────
-- 回傳距離最小的 p_limit 塊，附文件標題。similarity = 1 - cosine distance。
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  p_tenant_id uuid,
  p_query     extensions.vector(768),
  p_limit     int DEFAULT 8,
  p_min_similarity double precision DEFAULT 0.0
)
RETURNS TABLE (
  chunk_id    uuid,
  document_id uuid,
  title       text,
  chunk_index int,
  content     text,
  similarity  double precision
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
  SELECT c.id, c.document_id, d.title, c.chunk_index, c.content,
         1 - (c.embedding <=> p_query) AS similarity
    FROM public.knowledge_chunks c
    JOIN public.knowledge_documents d ON d.id = c.document_id
   WHERE c.tenant_id = p_tenant_id
     AND d.status = 'indexed'
     AND c.embedding IS NOT NULL
     AND 1 - (c.embedding <=> p_query) >= p_min_similarity
   ORDER BY c.embedding <=> p_query
   LIMIT p_limit;
$$;
REVOKE ALL ON FUNCTION public.match_knowledge_chunks(uuid, extensions.vector, int, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_knowledge_chunks(uuid, extensions.vector, int, double precision) TO service_role;

-- ── 私有 bucket：名片影像、知識庫檔案 ─────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('vendor-cards', 'vendor-cards', false),
       ('knowledge-files', 'knowledge-files', false)
ON CONFLICT (id) DO NOTHING;
UPDATE storage.buckets SET public = false
 WHERE id IN ('vendor-cards', 'knowledge-files') AND public IS DISTINCT FROM false;
