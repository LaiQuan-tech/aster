"use client";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText } from "@/components/admin-ui";
import { getProjectOverview, updateProject, statusLabel, type OverviewProject, type ProjectStatus } from "@/lib/projects-api";

/**
 * 專案看板（依案情狀態分欄，可拖拉改狀態）。資料來自 GET /projects/overview
 * （一次撈齊，前端只排版）。沒填起訖日的案子在卡片上標「未填起訖日」
 * ——不藏，讓人去補。
 *
 * B4 拖拉改狀態：HTML5 原生 drag-and-drop（不引第三方套件）。卡片拖進另一欄
 * → `window.prompt` 填變更理由（比照這支 repo 其他「改狀態／作廢」流程的既有
 * 慣例，見 SubcontractsCard／BillingsCard／ContractsCard 的 window.prompt）→
 * 打既有的 `PATCH /projects/:id`（`updateProject` 帶 status／statusReason）→
 * 成功就整包 reload 對齊後端（例如自動解除封存這類副作用）；失敗就把本地
 * 樂觀搬動的卡片復原——「回彈」靠的是這裡的 revert，不是重新整理才看得到。
 */
const STATUS_ORDER: ProjectStatus[] = ["active", "suspended", "closed", "terminated"];
const STATUS_CLS: Record<ProjectStatus, string> = {
  active: "bg-green-500",
  suspended: "bg-amber-500",
  closed: "bg-gray-400",
  terminated: "bg-red-500",
};
const money = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString("zh-TW")}`);

export default function ProjectOverviewPage() {
  const [projects, setProjects] = useState<OverviewProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 預設含結案／解約：專案列表本來就列出它們（封存前都看得到），總覽若預設藏起來，
  // 看板「結案」欄會顯示 0，看起來就像狀態沒有跟列表連動。
  const [showClosed, setShowClosed] = useState(true);
  // 拖拉改狀態中：擋掉重疊的第二次拖放，卡片上疊一層半透明遮罩。
  const [movingId, setMovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    return getProjectOverview()
      .then((r) => { setProjects(r.projects); })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => (showClosed ? projects : projects.filter((p) => p.status === "active" || p.status === "suspended")), [projects, showClosed]);
  // 不含結案／解約時，被藏起來的件數照樣算給看板欄位，欄頭數字才會和列表一致。
  const hiddenByStatus = useMemo(() => {
    const out: Partial<Record<ProjectStatus, number>> = {};
    if (!showClosed) for (const p of projects) if (p.status === "closed" || p.status === "terminated") out[p.status] = (out[p.status] ?? 0) + 1;
    return out;
  }, [projects, showClosed]);

  /**
   * 看板拖拉改狀態：同欄放回原地不動；跨欄放下先跳 `window.prompt` 收變更
   * 理由（比照既有「改狀態／作廢」的 window.prompt 慣例），取消或空白就整個
   * 放棄，卡片留在原欄。理由填了才樂觀把卡片搬到新欄，同時打
   * `PATCH /projects/:id`；成功後用 GET /projects/overview 整包 reload 對齊
   * 後端（例如終止狀態可能觸發封存副作用）；失敗則把本地狀態改回原狀
   * （＝失敗回彈），並把錯誤訊息秀出來。
   */
  async function handleDropStatus(id: string, from: ProjectStatus, to: ProjectStatus, name: string) {
    if (from === to || movingId) return;
    const reason = window.prompt(`把「${name}」從「${statusLabel(from)}」改成「${statusLabel(to)}」，請填變更理由：`);
    if (!reason || !reason.trim()) return;
    setMovingId(id);
    setError(null);
    const prevProjects = projects;
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, status: to } : p)));
    try {
      await updateProject(id, { status: to, statusReason: reason.trim() });
      await load();
    } catch (err) {
      setProjects(prevProjects); // 失敗回彈：卡片退回原本的欄。
      setError(err instanceof Error ? err.message : "變更狀態失敗");
    } finally {
      setMovingId(null);
    }
  }

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="ml-auto flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> 含結案／解約
        </label>
        <Link href="/admin/projects/alerts" className="text-sm hover:underline" style={{ color: "var(--brand)" }}>
          進度示警 →
        </Link>
      </div>
      {projects.length === 0 ? (
        <Card><Empty>尚無專案</Empty></Card>
      ) : (
        <Kanban projects={visible} hiddenByStatus={hiddenByStatus} movingId={movingId} onDropStatus={handleDropStatus} />
      )}
    </>
  );
}

function AlertBadges({ a }: { a: OverviewProject["alerts"] }) {
  if (a.high + a.medium + a.low === 0) return null;
  return (
    <span className="inline-flex gap-1">
      {a.high > 0 && <span className="rounded-full bg-red-100 px-1.5 text-[11px] font-semibold text-red-700" title="急">{a.high}</span>}
      {a.medium > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-700" title="注意">{a.medium}</span>}
      {a.low > 0 && <span className="rounded-full bg-gray-100 px-1.5 text-[11px] text-gray-500" title="提醒">{a.low}</span>}
    </span>
  );
}

/** 拖拉時放進 dataTransfer 的內容——目的地欄只需要來源卡片的這三樣。 */
type DragPayload = { id: string; status: ProjectStatus; name: string };
const DRAG_MIME = "application/json";

function Kanban({
  projects,
  hiddenByStatus = {},
  movingId,
  onDropStatus,
}: {
  projects: OverviewProject[];
  /** 因為沒勾「含結案／解約」而沒畫出來的件數（依狀態）。 */
  hiddenByStatus?: Partial<Record<ProjectStatus, number>>;
  movingId: string | null;
  onDropStatus: (id: string, from: ProjectStatus, to: ProjectStatus, name: string) => void;
}) {
  // 四欄一律都顯示（即使目前是空的）——拖拉功能需要每一欄都是有效的放置目標，
  // 不能像純瀏覽時那樣把沒有卡片、又不是「進行中」的欄隱藏起來。
  const cols = STATUS_ORDER.map((s) => ({ status: s, items: projects.filter((p) => p.status === s), hidden: hiddenByStatus[s] ?? 0 }));
  const [dragOver, setDragOver] = useState<ProjectStatus | null>(null);

  function readPayload(e: DragEvent): DragPayload | null {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DragPayload;
    } catch {
      return null;
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {cols.map((c) => (
        <div
          key={c.status}
          onDragOver={(e) => {
            e.preventDefault(); // 沒有這行瀏覽器不允許 drop。
            e.dataTransfer.dropEffect = "move";
            if (dragOver !== c.status) setDragOver(c.status);
          }}
          onDragLeave={() => setDragOver((s) => (s === c.status ? null : s))}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const payload = readPayload(e);
            if (!payload) return;
            onDropStatus(payload.id, payload.status, c.status, payload.name);
          }}
          className={`rounded-xl border p-3 transition-colors ${
            dragOver === c.status ? "border-[var(--brand)] bg-blue-50/50" : "border-gray-100 bg-gray-50"
          }`}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${STATUS_CLS[c.status]}`} />
            <span className="text-sm font-semibold text-gray-700">{statusLabel(c.status)}</span>
            <span className="text-xs text-gray-400">{c.items.length + c.hidden}</span>
          </div>
          <div className="space-y-2">
            {c.items.length === 0 && c.hidden === 0 && <p className="py-3 text-center text-xs text-gray-400">無</p>}
            {c.hidden > 0 && (
              <p className="py-3 text-center text-xs text-gray-400">{c.hidden} 件已隱藏（勾選「含結案／解約」顯示）</p>
            )}
            {c.items.map((p) => {
              const pct = p.contractTotal ? Math.min(100, Math.round((p.billedTotal / p.contractTotal) * 100)) : null;
              return (
                <Link
                  key={p.id}
                  href={`/admin/projects/${p.id}`}
                  draggable
                  onDragStart={(e) => {
                    const payload: DragPayload = { id: p.id, status: p.status, name: p.name };
                    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  className={`block cursor-grab rounded-lg border border-gray-100 bg-white p-3 hover:border-gray-300 active:cursor-grabbing ${
                    movingId === p.id ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">{p.name}</p>
                      <p className="text-xs text-gray-400">{p.code ?? "無編號"}{p.leadName ? `・${p.leadName}` : ""}</p>
                    </div>
                    <AlertBadges a={p.alerts} />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    {p.startsOn || p.endsOn ? `${p.startsOn ?? "?"} → ${p.endsOn ?? "?"}` : <span className="text-amber-700">未填起訖日</span>}
                  </p>
                  {p.contractTotal != null && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[11px] text-gray-500"><span>已請款 {money(p.billedTotal)}</span><span>{pct}% / {money(p.contractTotal)}</span></div>
                      <div className="mt-1 h-1.5 w-full rounded bg-gray-100"><div className="h-1.5 rounded" style={{ width: `${pct ?? 0}%`, backgroundColor: "var(--brand)" }} /></div>
                    </div>
                  )}
                  {!p.hasContract && p.status === "active" && <p className="mt-1 text-[11px] text-amber-700">尚無合約</p>}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
