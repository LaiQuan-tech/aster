"use client";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, Segmented } from "@/components/admin-ui";
import { getProjectOverview, updateProject, statusLabel, type OverviewProject, type ProjectStatus } from "@/lib/projects-api";

/**
 * 專案總覽：看板（依案情狀態分欄，可拖拉改狀態）與甘特圖（預定起訖 + 分期
 * 請款里程碑）。資料來自 GET /projects/overview（一次撈齊，前端只排版）。
 * 沒填起訖日的案子在甘特圖上以建立日～今天畫虛線，並在卡片上標「未填日期」
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
  const [tab, setTab] = useState<"kanban" | "gantt">("kanban");
  const [projects, setProjects] = useState<OverviewProject[]>([]);
  const [today, setToday] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  // 拖拉改狀態中：擋掉重疊的第二次拖放，卡片上疊一層半透明遮罩。
  const [movingId, setMovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    return getProjectOverview()
      .then((r) => { setProjects(r.projects); setToday(r.today); })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => (showClosed ? projects : projects.filter((p) => p.status === "active" || p.status === "suspended")), [projects, showClosed]);

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
        <Segmented
          options={[
            { value: "kanban", label: "看板" },
            { value: "gantt", label: "甘特圖" },
          ]}
          value={tab}
          onChange={setTab}
          className="w-full md:w-auto"
          aria-label="總覽檢視切換"
        />
        <label className="ml-auto flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> 含結案／解約
        </label>
        <Link href="/admin/projects/alerts" className="text-sm hover:underline" style={{ color: "var(--brand)" }}>
          進度示警 →
        </Link>
      </div>
      {projects.length === 0 ? (
        <Card><Empty>尚無專案</Empty></Card>
      ) : tab === "kanban" ? (
        <Kanban projects={visible} movingId={movingId} onDropStatus={handleDropStatus} />
      ) : (
        <Gantt projects={visible} today={today} />
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
  movingId,
  onDropStatus,
}: {
  projects: OverviewProject[];
  movingId: string | null;
  onDropStatus: (id: string, from: ProjectStatus, to: ProjectStatus, name: string) => void;
}) {
  // 四欄一律都顯示（即使目前是空的）——拖拉功能需要每一欄都是有效的放置目標，
  // 不能像純瀏覽時那樣把沒有卡片、又不是「進行中」的欄隱藏起來。
  const cols = STATUS_ORDER.map((s) => ({ status: s, items: projects.filter((p) => p.status === s) }));
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
            <span className="text-xs text-gray-400">{c.items.length}</span>
          </div>
          <div className="space-y-2">
            {c.items.length === 0 && <p className="py-3 text-center text-xs text-gray-400">無</p>}
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

/* ------------------------------------------------------------- 甘特圖 -- */
const DAY = 86_400_000;
const d = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).getTime();
const fmtMonth = (t: number) => { const x = new Date(t); return `${x.getUTCFullYear()}/${x.getUTCMonth() + 1}`; };

function Gantt({ projects, today }: { projects: OverviewProject[]; today: string }) {
  const rows = useMemo(() => {
    const t0 = today ? d(today) : Date.now();
    return projects.map((p) => {
      const start = p.startsOn ? d(p.startsOn) : d(p.createdAt);
      const end = p.endsOn ? d(p.endsOn) : Math.max(t0, start + 7 * DAY);
      return { p, start, end, dashed: !p.startsOn || !p.endsOn };
    }).sort((a, b) => a.start - b.start);
  }, [projects, today]);
  if (rows.length === 0) return <Card><Empty>沒有可顯示的專案</Empty></Card>;

  const t0 = today ? d(today) : Date.now();
  let min = Math.min(...rows.map((r) => r.start), t0);
  let max = Math.max(...rows.map((r) => r.end), t0);
  // 對齊到月初／月底，前後各留半個月
  const mm = new Date(min); min = Date.UTC(mm.getUTCFullYear(), mm.getUTCMonth(), 1) - 15 * DAY;
  const mx = new Date(max); max = Date.UTC(mx.getUTCFullYear(), mx.getUTCMonth() + 1, 1) + 15 * DAY;
  const span = max - min;
  const LABEL_W = 220, ROW_H = 34, HEAD_H = 28, W = 1000;
  const x = (t: number) => LABEL_W + ((t - min) / span) * (W - LABEL_W);
  const months: number[] = [];
  for (let m = new Date(min); m.getTime() < max; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1);
    if (t >= min) months.push(t);
  }
  const H = HEAD_H + rows.length * ROW_H + 8;

  return (
    <Card>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-gray-500">
        <span><span className="mr-1 inline-block h-2 w-4 rounded bg-green-500 align-middle" />進行中</span>
        <span><span className="mr-1 inline-block h-2 w-4 rounded bg-amber-500 align-middle" />停工</span>
        <span><span className="mr-1 inline-block h-2 w-4 rounded bg-gray-400 align-middle" />結案</span>
        <span><span className="mr-1 inline-block h-2 w-4 rounded bg-red-500 align-middle" />解約</span>
        <span>◇ 分期請款預定日（實心＝已請款）</span>
        <span>虛線＝未填起訖日，以建立日～今天代替</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 800 }} role="img" aria-label="專案甘特圖">
          {months.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={HEAD_H - 6} y2={H} stroke="#e5e7eb" strokeWidth={1} />
              <text x={x(t) + 3} y={12} fontSize={10} fill="#6b7280">{fmtMonth(t)}</text>
            </g>
          ))}
          <line x1={x(t0)} x2={x(t0)} y1={HEAD_H - 6} y2={H} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" />
          <text x={x(t0) + 3} y={HEAD_H - 8} fontSize={10} fill="#ef4444">今天</text>
          {rows.map((r, i) => {
            const y = HEAD_H + i * ROW_H;
            const color = r.p.status === "active" ? "#22c55e" : r.p.status === "suspended" ? "#f59e0b" : r.p.status === "closed" ? "#9ca3af" : "#ef4444";
            const x1 = x(r.start), x2 = Math.max(x(r.end), x1 + 4);
            return (
              <g key={r.p.id}>
                <line x1={0} x2={W} y1={y + ROW_H} y2={y + ROW_H} stroke="#f3f4f6" />
                <a href={`/admin/projects/${r.p.id}`}>
                  <text x={8} y={y + 14} fontSize={12} fill="#111827" fontWeight={600}>{trunc(r.p.name, 14)}</text>
                  <text x={8} y={y + 27} fontSize={10} fill="#6b7280">{r.p.code ?? ""}{r.p.leadName ? `・${r.p.leadName}` : ""}{r.p.alerts.high ? `　⚠${r.p.alerts.high}` : ""}</text>
                </a>
                <rect x={x1} y={y + 9} width={x2 - x1} height={14} rx={4} fill={color} opacity={r.dashed ? 0.35 : 0.85} stroke={r.dashed ? color : "none"} strokeDasharray={r.dashed ? "4 3" : undefined} />
                {r.p.milestones.map((m) => {
                  if (!m.plannedOn) return null;
                  const mx = x(d(m.plannedOn));
                  const overdue = !m.billedOn && d(m.plannedOn) < t0;
                  return (
                    <g key={m.installmentNo}>
                      <polygon points={`${mx},${y + 6} ${mx + 6},${y + 16} ${mx},${y + 26} ${mx - 6},${y + 16}`} fill={m.billedOn ? "#1f2937" : "#fff"} stroke={overdue ? "#ef4444" : "#1f2937"} strokeWidth={overdue ? 2 : 1.2} />
                      <title>{`第 ${m.installmentNo} 期 ${m.plannedOn}${m.amount != null ? ` ${money(m.amount)}` : ""}${m.billedOn ? `（已請款 ${m.billedOn}）` : overdue ? "（逾期未請款）" : ""}`}</title>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </Card>
  );
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
