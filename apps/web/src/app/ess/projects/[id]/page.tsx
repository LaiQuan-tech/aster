"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, InlineError, Pill, SectionTitle } from "@/components/ess-ui";
import {
  getProjectMembers,
  getProjectDocuments,
  uploadProjectDocument,
  type MembersResponse,
  type ProjectDocument,
} from "@/lib/projects-api";
import {
  getProjectDetail,
  ENGINEER_DISCIPLINE_LABELS,
  ENGINEER_DISCIPLINES,
  type ProjectDetail,
} from "@/lib/projects-ext-api";

function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("zh-TW");
}

export default function EssProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [membersRes, setMembersRes] = useState<MembersResponse | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const [detail, m, docs] = await Promise.all([
        getProjectDetail(projectId),
        getProjectMembers(projectId),
        getProjectDocuments(projectId),
      ]);
      // 金額（money）與財務用的分潤細節不在這裡顯示——非 finance 者本來就拿
      // 不到（API 回 null），這裡只取基本資料／協力技師／客戶名稱／簽約狀態。
      setProject(detail.project);
      setMembersRes(m);
      setDocuments(docs.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function onUpload(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      await uploadProjectDocument(projectId, file);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗（可能沒有上傳權限）");
    }
  }

  const isPool = membersRes?.shareMode === "pool_pct";
  const canManage = membersRes?.canManage ?? false;

  return (
    <div className="space-y-4">
      <Link href="/ess/projects" className="text-sm text-gray-500 hover:underline">← 專案列表</Link>

      {loading ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : !project ? (
        <InlineError>{error ?? "找不到專案"}</InlineError>
      ) : (
        <>
          {/* 專案資訊（只給基本資料；金額不在 ESS 顯示，非 finance 者 API 本來就回 null） */}
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <SectionTitle>{project.name}</SectionTitle>
              {project.hasSignedContract ? (
                <Pill tone="blue">已簽約</Pill>
              ) : (
                <Pill tone="gray">報價單／未簽</Pill>
              )}
            </div>
            {project.code && <p className="font-mono text-xs text-gray-400">{project.code}</p>}
            {project.client?.name && <p className="mt-1 text-sm text-gray-600">客戶：{project.client.name}</p>}
            {project.description && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{project.description}</p>}
            {ENGINEER_DISCIPLINES.some((d) => project.engineers?.[d]?.name) && (
              <div className="mt-3 flex flex-wrap gap-3 border-t border-gray-100 pt-3 text-sm">
                {ENGINEER_DISCIPLINES.filter((d) => project.engineers?.[d]?.name).map((d) => (
                  <span key={d} className="text-gray-600">
                    <span className="text-gray-400">{ENGINEER_DISCIPLINE_LABELS[d]}：</span>
                    {project.engineers?.[d]?.name}
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* 文件 */}
          <Card title="專案文件">
            <input ref={fileRef} type="file" className="mb-3 block text-sm" onChange={(e) => onUpload(e.target.files?.[0])} />
            {documents.length === 0 ? (
              <p className="text-sm text-gray-400">尚無文件</p>
            ) : (
              <ul className="divide-y">
                {documents.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="min-w-0">
                      <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium" style={{ color: "var(--brand)" }}>
                        {doc.fileName}
                      </a>
                      {doc.contractId && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">合約掃描檔</span>}
                    </span>
                    <span className="text-xs text-gray-400">{Math.round(doc.sizeBytes / 1024)} KB</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 分潤（可見性由後端決定：一般組員只看到自己那筆；負責人/部門主管看全部） */}
          <Card
            title="獎金分潤"
            action={<span className="text-xs text-gray-400">{canManage ? "你可檢視全部成員分潤" : "僅顯示你自己的分潤"}</span>}
          >
            {!membersRes || membersRes.members.length === 0 ? (
              <p className="text-sm text-gray-400">尚無分潤資料</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs text-gray-500">
                      <th className="py-2 pr-3">成員</th>
                      <th className="py-2 pr-3">{isPool ? "分潤 %" : "分潤金額"}</th>
                      <th className="py-2 pr-3">實得金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {membersRes.members.map((m) => (
                      <tr key={m.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-medium text-gray-800">
                          {m.name ?? "我"}
                          {m.roleInProject === "lead" && <span className="ml-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">負責人</span>}
                        </td>
                        <td className="py-2 pr-3 text-gray-700">{isPool ? (m.sharePct != null ? `${m.sharePct}%` : "—") : money(m.shareAmount)}</td>
                        <td className="py-2 pr-3 font-medium text-gray-900">{money(m.computedAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
