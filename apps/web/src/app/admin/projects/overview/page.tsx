"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, Empty, ErrorText } from "@/components/admin-ui";
import { getProjectOverview, statusLabel, type OverviewProject, type ProjectStatus } from "@/lib/projects-api";

/**
 * 專案總覽：看板（依案情狀態分欄）與甘特圖（預定起訖 + 分期請款里程碑）。
 * 資料來自 GET /projects/overview（一次撈齊，前端只排版）。沒填起訖日的案子在
 * 甘特圖上以建立日～今天畫虛線，並在卡片上標「未填日期」——不藏，讓人去補。
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

  useEffect(() => {
    getProjectOverview()
      .then((r) => { setProjects(r.projects); setToday(r.today); })
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  const visible = useMemo(() => (showClosed ? projects : projects.filter((p) => p.status === "active" || p.status === "suspended")), [projects, showClosed]);

  return (
    <>
      <PageHeader title="專案總覽" desc="看板依案情狀態分欄；甘特圖看預定期程與請款里程碑。點卡片進專案。" />
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["kanban", "gantt"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${tab === t ? "text-white" : "border border-gray-200 bg-white text-gray-600"}`}
            style={tab === t ? { backgroundColor: "var(--brand)" } : undefined}>
            {t === "kanban" ? "看板" : "甘特圖"}
          </button>
        ))}
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
        <Kanban projects={visible} />
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

function Kanban({ projects }: { projects: OverviewProject[] }) {
  const cols = STATUS_ORDER.map((s) => ({ status: s, items: projects.filter((p) => p.status === s) })).filter((c) => c.items.length > 0 || c.status === "active");
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {cols.map((c) => (
        <div key={c.status} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
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
                <Link key={p.id} href={`/admin/projects/${p.id}`} className="block rounded-lg border border-gray-100 bg-white p-3 hover:border-gray-300">
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
