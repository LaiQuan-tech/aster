"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BottomSheet,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Input,
  Select,
  useToast,
} from "@/components/admin-ui";
import { getEmployees, type Employee } from "@/lib/admin-api";
import {
  DUTY_LABEL,
  deleteDutyRoster,
  generateDutyRoster,
  listDutyRosters,
  updateDutyRoster,
  type DutyRoster,
  type DutyType,
} from "@/lib/people-extras-api";

/**
 * 值日生／總機輪播排班（M8）。
 *
 * 一個月一張表、兩欄（值日／總機），一眼看得出「今天輪到誰、這個月怎麼排」。
 * 產生器讓 HR 選**有序**的參與者名單與起訖日，一鍵輪播——只排工作日
 * （`tenant_calendar_days` 有覆寫就聽它，補班的週六會排、彈性放假的平日不排）。
 *
 * 已排的日子預設**跳過不覆蓋**：手動換過的那幾天不該被重跑的產生器洗掉；
 * 要整段重來就勾「先清掉這段期間的舊排班」。
 */

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const DUTY_TYPES: DutyType[] = ["duty", "reception"];

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(month: string): { from: string; to: string; days: string[] } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= last; d++) days.push(`${month}-${String(d).padStart(2, "0")}`);
  return { from: days[0], to: days[days.length - 1], days };
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

interface CellTarget {
  date: string;
  dutyType: DutyType;
  roster: DutyRoster | null;
}

export default function DutyRostersPage() {
  const toast = useToast();
  const [month, setMonth] = useState(monthKey());
  const [rosters, setRosters] = useState<DutyRoster[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [cell, setCell] = useState<CellTarget | null>(null);
  const [cellEmpId, setCellEmpId] = useState("");
  const [busy, setBusy] = useState(false);

  const [genOpen, setGenOpen] = useState(false);
  const [genType, setGenType] = useState<DutyType>("duty");
  const [genFrom, setGenFrom] = useState("");
  const [genTo, setGenTo] = useState("");
  const [genParticipants, setGenParticipants] = useState<string[]>([]);
  const [genStartEmpId, setGenStartEmpId] = useState("");
  const [genReplace, setGenReplace] = useState(false);

  const { from, to, days } = useMemo(() => monthRange(month), [month]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === "active"), [employees]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listDutyRosters({ from, to });
      setRosters(res.rosters);
    } catch (err) {
      setRosters((prev) => prev ?? []);
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getEmployees()
      .then((r) => setEmployees(r.employees))
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!genOpen) return;
    setGenFrom((v) => v || from);
    setGenTo((v) => v || to);
  }, [genOpen, from, to]);

  const byKey = useMemo(() => {
    const map = new Map<string, DutyRoster>();
    for (const r of rosters ?? []) map.set(`${r.duty_type}|${r.work_date}`, r);
    return map;
  }, [rosters]);

  function openCell(date: string, dutyType: DutyType) {
    const roster = byKey.get(`${dutyType}|${date}`) ?? null;
    setCell({ date, dutyType, roster });
    setCellEmpId(roster?.employee_id ?? "");
  }

  async function saveCell() {
    if (!cell || !cellEmpId) return;
    setBusy(true);
    try {
      if (cell.roster) {
        await updateDutyRoster(cell.roster.id, { employeeId: cellEmpId });
        toast.show("已換人", "success");
      } else {
        // 單日指派＝對這一天跑一次只有一位參與者的輪播（非工作日會回 created 0）。
        const res = await generateDutyRoster({
          dutyType: cell.dutyType,
          participantEmpIds: [cellEmpId],
          from: cell.date,
          to: cell.date,
        });
        toast.show(
          res.created > 0 ? "已指派" : "這一天不是工作日，沒有排入",
          res.created > 0 ? "success" : "info",
        );
      }
      setCell(null);
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "儲存失敗", "error");
    } finally {
      setBusy(false);
    }
  }

  async function clearCell() {
    if (!cell?.roster) return;
    setBusy(true);
    try {
      await deleteDutyRoster(cell.roster.id);
      setCell(null);
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "刪除失敗", "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleParticipant(id: string) {
    setGenParticipants((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function runGenerate() {
    if (genParticipants.length === 0) {
      toast.show("請至少選一位參與者", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await generateDutyRoster({
        dutyType: genType,
        participantEmpIds: genParticipants,
        from: genFrom,
        to: genTo,
        replaceExisting: genReplace,
        ...(genStartEmpId ? { startEmpId: genStartEmpId } : {}),
      });
      toast.show(
        `工作日 ${res.workdays} 天：新排 ${res.created} 天、跳過 ${res.skipped} 天` +
          (res.replaced > 0 ? `、清掉舊的 ${res.replaced} 天` : ""),
        "success",
      );
      setGenOpen(false);
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "產生失敗", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-gray-500">月排班</h2>
            <p className="mt-1 text-xs text-gray-400">
              只排工作日；點任何一格可換人或清掉。員工端首頁會顯示今日的值日與總機。
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-sm text-gray-600">
              月份
              <Input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value || monthKey())}
                className="ml-2 inline-block w-40"
              />
            </label>
            <Button onClick={() => setGenOpen(true)}>產生輪播</Button>
          </div>
        </div>

        {error && (
          <div className="mt-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        {rosters === null ? (
          <Empty>載入中…</Empty>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2">日期</th>
                  <th className="py-2">星期</th>
                  {DUTY_TYPES.map((t) => (
                    <th key={t} className="py-2">
                      {DUTY_LABEL[t]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((date) => {
                  const wd = weekdayOf(date);
                  const weekend = wd === 0 || wd === 6;
                  return (
                    <tr key={date} className={`border-b border-gray-100 ${weekend ? "bg-gray-50" : ""}`}>
                      <td className="py-2 text-gray-800">{date.slice(5).replace("-", "/")}</td>
                      <td className={`py-2 ${weekend ? "text-gray-400" : "text-gray-600"}`}>{WEEKDAY[wd]}</td>
                      {DUTY_TYPES.map((t) => {
                        const roster = byKey.get(`${t}|${date}`) ?? null;
                        return (
                          <td key={t} className="py-1.5">
                            <button
                              type="button"
                              onClick={() => openCell(date, t)}
                              className={`min-h-8 w-full rounded-lg px-2 py-1 text-left transition hover:bg-gray-100 ${
                                roster ? "text-gray-800" : "text-gray-300"
                              }`}
                            >
                              {roster?.employeeName ?? "—"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 換人／清空 */}
      <BottomSheet
        open={!!cell}
        onClose={() => setCell(null)}
        title={cell ? `${cell.date} · ${DUTY_LABEL[cell.dutyType]}` : undefined}
      >
        {cell && (
          <div className="space-y-4">
            <Field label="指派給">
              <Select value={cellEmpId} onChange={(e) => setCellEmpId(e.target.value)}>
                <option value="">請選擇</option>
                {activeEmployees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex gap-2">
              <Button block onClick={() => void saveCell()} loading={busy} disabled={!cellEmpId}>
                儲存
              </Button>
              {cell.roster && (
                <Button variant="danger" block onClick={() => void clearCell()} loading={busy}>
                  清掉這天
                </Button>
              )}
            </div>
          </div>
        )}
      </BottomSheet>

      {/* 產生器 */}
      <BottomSheet open={genOpen} onClose={() => setGenOpen(false)} title="產生輪播排班">
        <div className="space-y-4">
          <Field label="職務">
            <Select value={genType} onChange={(e) => setGenType(e.target.value as DutyType)}>
              {DUTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DUTY_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="起">
              <Input type="date" value={genFrom} onChange={(e) => setGenFrom(e.target.value)} />
            </Field>
            <Field label="迄">
              <Input type="date" value={genTo} onChange={(e) => setGenTo(e.target.value)} />
            </Field>
          </div>

          <Field
            label="參與者（點選的順序就是輪播順序）"
            hint={genParticipants.length > 0 ? `已選 ${genParticipants.length} 位` : "至少選一位"}
          >
            <div className="flex flex-wrap gap-2">
              {activeEmployees.map((e) => {
                const idx = genParticipants.indexOf(e.id);
                const picked = idx >= 0;
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => toggleParticipant(e.id)}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                      picked ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                    style={picked ? { backgroundColor: "var(--brand)" } : undefined}
                  >
                    {picked ? `${idx + 1}. ` : ""}
                    {e.name}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="從誰開始" hint="留空＝名單第一位">
            <Select value={genStartEmpId} onChange={(e) => setGenStartEmpId(e.target.value)}>
              <option value="">名單第一位</option>
              {genParticipants.map((id) => (
                <option key={id} value={id}>
                  {activeEmployees.find((e) => e.id === id)?.name ?? id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </Field>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={genReplace}
              onChange={(e) => setGenReplace(e.target.checked)}
              className="mt-1"
            />
            <span>
              先清掉這段期間的舊排班
              <span className="block text-xs text-gray-400">
                不勾＝已經排過的日子跳過（手動換過的人不會被洗掉）
              </span>
            </span>
          </label>

          <div className="flex gap-2">
            <Button block onClick={() => void runGenerate()} loading={busy}>
              產生
            </Button>
            <Button variant="secondary" block onClick={() => setGenOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
