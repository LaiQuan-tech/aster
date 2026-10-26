"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, InlineError, Pill, SectionTitle } from "@/components/ess-ui";
import {
  getProjectMembers,
  getProjectSettings,
  getProjectDocuments,
  uploadProjectDocument,
  visibleProjectDocuments,
  type MembersResponse,
  type ProjectDocument,
  type ProjectMemberRole,
} from "@/lib/projects-api";
import {
  getProjectDetail,
  updateProjectFields,
  disciplineLabel,
  type ProjectDetail,
  type ProjectMoney,
} from "@/lib/projects-ext-api";
import { MembersCard } from "@/app/admin/projects/[id]/_sections/MembersCard";
import { RoleSharePctCard } from "@/app/admin/projects/_components/RoleSharePctCard";
import { effectiveRoleSharePct } from "@/lib/project-share-calculation";

function money(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("zh-TW");
}

export default function EssProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [membersRes, setMembersRes] = useState<MembersResponse | null>(null);
  // 分潤改版 #6：老闆不一定是 HR、進不了後台專案頁——員工端專案頁直接給老闆分潤編輯器。
  const [projectMoney, setProjectMoney] = useState<ProjectMoney | null>(null);
  const [shareDefaults, setShareDefaults] = useState<Partial<Record<ProjectMemberRole, number>>>({});
  const [shareError, setShareError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  // 合約掃描檔只給 HR／該案 lead／經理與主辦成員；後端對其他人的回應根本不含合約掃描檔（連檔名都不給），
  // 這個旗標讓前端對應：沒權限就不顯示「合約掃描檔」徽章，連萬一混進來的也濾掉。
  const [canSeeContractDocs, setCanSeeContractDocs] = useState(false);
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
      setProjectMoney(detail.money);
      setMembersRes(m);
      if (m.canEditBonus) {
        // 本案各角色分潤趴數（2026-10-27）；本案未設定時退回租戶的新專案起始值。
        const st = await getProjectSettings().catch(() => null);
        setShareDefaults(effectiveRoleSharePct(detail.project.sharePctByRole, st?.settings.defaultSharePctByRole));
      }
      setDocuments(docs.documents);
      setCanSeeContractDocs(docs.canSeeContractDocs);
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

  // 沒有權限的人：合約掃描檔一律不顯示（後端本來就不回，這裡再濾一次，兩邊對應）。
  const visibleDocuments = visibleProjectDocuments(documents, canSeeContractDocs);
  const isPool = membersRes?.shareMode === "pool_pct";
  const canManage = membersRes?.canManage ?? false;

  // 技師：直接走專案上實際存在的科別 key（不打 project-settings 拿清單），所以舊專案的
  // 英文 key（electrical／hvac／fire）與租戶自訂科別都列得出來；顯示名交給
  // disciplineLabel()（＝ENGINEER_DISCIPLINE_LABELS 對照，中文／自訂 key 原樣顯示）。
  const engineerRows = Object.entries(project?.engineers ?? {}).flatMap(([discipline, assignment]) =>
    assignment?.name ? [{ discipline, label: disciplineLabel(discipline), name: assignment.name }] : [],
  );

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
            {engineerRows.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3 border-t border-gray-100 pt-3 text-sm">
                {engineerRows.map((row) => (
                  <span key={row.discipline} className="text-gray-600">
                    <span className="text-gray-400">{row.label}：</span>
                    {row.name}
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* 文件：一般專案文件全公司可見；合約掃描檔只給有權者（見上面 canSeeContractDocs） */}
          <Card title="專案文件">
            <input ref={fileRef} type="file" className="mb-3 block text-sm" onChange={(e) => onUpload(e.target.files?.[0])} />
            {/* 上傳失敗（檔案太大、沒權限…）原本只在「找不到專案」那個分支才顯示，載入成功後完全看不到。 */}
            {error && <div className="mb-3"><InlineError>{error}</InlineError></div>}
            {visibleDocuments.length === 0 ? (
              <p className="text-sm text-gray-400">尚無文件</p>
            ) : (
              <ul className="divide-y">
                {visibleDocuments.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="min-w-0">
                      <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium" style={{ color: "var(--brand)" }}>
                        {doc.fileName}
                      </a>
                      {canSeeContractDocs && doc.contractId && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">合約掃描檔</span>}
                    </span>
                    <span className="text-xs text-gray-400">{Math.round(doc.sizeBytes / 1024)} KB</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 老闆：分潤編輯器（比例與角色；加人／移除仍由 HR／負責人在後台）。 */}
          {membersRes?.canEditBonus && (
            <>
              {/* 老闆：本案各角色分潤趴數（專案申請單的同一組設定；新增成員時依角色帶入）。 */}
              <RoleSharePctCard
                idPrefix="ess-project-role-share"
                title="各角色分潤趴數"
                description={project.sharePctByRole != null
                  ? "本案新增成員時依角色自動帶入（每位成員的趴數）。"
                  : "本案尚未設定，目前沿用新專案起始值；儲存後即為本案自己的設定。"}
                values={shareDefaults}
                canEdit
                bossConfigured={membersRes.bossConfigured !== false}
                allowUnset
                onSave={async (value) => {
                  await updateProjectFields(projectId, { sharePctByRole: value });
                  await load();
                }}
              />
              <MembersCard
                projectId={projectId}
                members={membersRes.members}
                emps={membersRes.members.map((mm) => ({ id: mm.employeeId, name: mm.name ?? mm.employeeId, emp_no: mm.empNo }))}
                canBonus
                canEditBonus
                bossConfigured={membersRes.bossConfigured !== false}
                defaultSharePctByRole={shareDefaults}
                contractAmount={projectMoney?.amountUntaxed ?? null}
                receivedAmount={projectMoney?.receivedTotal ?? 0}
                grossProfit={membersRes.bonusEstimate && membersRes.bonusEstimate.basis === "gross_profit" ? membersRes.bonusEstimate.grossProfit : null}
                taxInclusiveVatRate={membersRes.bonusEstimate && membersRes.bonusEstimate.basis === "tax_inclusive_receipts" ? (membersRes.bonusEstimate.vatRate ?? 0.05) : null}
                bonusRatePct={membersRes.bonusRatePct ?? null}
                allowRosterEdit={false}
                setError={setShareError}
                load={load}
              />
              {shareError && <InlineError>{shareError}</InlineError>}
            </>
          )}

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
