"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { EssHeader } from "@/components/EssHeader";
import { getBranding, getMe, isAdminRole, type Branding } from "@/lib/ess-api";
import {
  getProject,
  getProjectMembers,
  getProjectDocuments,
  uploadProjectDocument,
  type Project,
  type MembersResponse,
  type ProjectDocument,
} from "@/lib/projects-api";

function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("zh-TW");
}

function ProjectDetailInner() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [membersRes, setMembersRes] = useState<MembersResponse | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const [p, m, docs] = await Promise.all([
        getProject(projectId),
        getProjectMembers(projectId),
        getProjectDocuments(projectId),
      ]);
      setProject(p.project);
      setMembersRes(m);
      setDocuments(docs.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
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
    <div className="min-h-screen bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="projects" isAdmin={isAdmin} />
      <main className="mx-auto max-w-3xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <Link href="/ess/projects" className="text-sm text-gray-500 hover:underline">← 專案列表</Link>

        {loading ? (
          <p className="text-sm text-gray-400">載入中…</p>
        ) : !project ? (
          <p className="text-sm text-red-600">{error ?? "找不到專案"}</p>
        ) : (
          <>
            {/* 專案資訊 */}
            <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
              <h2 className="text-lg font-semibold text-gray-900">{project.name}</h2>
              {project.code && <p className="font-mono text-xs text-gray-400">{project.code}</p>}
              {project.description && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{project.description}</p>}
            </section>

            {/* 文件 */}
            <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
              <h3 className="mb-3 text-sm font-semibold text-gray-700">專案文件</h3>
              <input ref={fileRef} type="file" className="mb-3 block text-sm" onChange={(e) => onUpload(e.target.files?.[0])} />
              {documents.length === 0 ? (
                <p className="text-sm text-gray-400">尚無文件</p>
              ) : (
                <ul className="divide-y">
                  {documents.map((doc) => (
                    <li key={doc.id} className="flex items-center justify-between py-2 text-sm">
                      <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium" style={{ color: "var(--brand)" }}>
                        {doc.fileName}
                      </a>
                      <span className="text-xs text-gray-400">{Math.round(doc.sizeBytes / 1024)} KB</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 分潤（可見性由後端決定：一般組員只看到自己那筆；負責人/部門主管看全部） */}
            <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700">獎金分潤</h3>
                <span className="text-xs text-gray-400">{canManage ? "你可檢視全部成員分潤" : "僅顯示你自己的分潤"}</span>
              </div>
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
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default function EssProjectDetailPage() {
  return (
    <AuthGate>
      <ProjectDetailInner />
    </AuthGate>
  );
}
