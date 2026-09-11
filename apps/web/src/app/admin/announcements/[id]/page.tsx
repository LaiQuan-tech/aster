"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Card,
  PageHeader,
  PrimaryButton,
  ErrorText,
  Empty,
  inputCls,
  labelCls,
} from "@/components/admin-ui";
import {
  getAnnouncementVersions,
  getAnnouncementAcks,
  getSignatureSheets,
  recordPaperSignature,
  uploadSignatureSheet,
  getEmployees,
  type AnnouncementVersion,
  type AnnouncementAck,
  type SignatureSheet,
  type Employee,
} from "@/lib/admin-api";

const CHANGE_LABEL: Record<AnnouncementVersion["change_type"], string> = {
  initial: "首版",
  amendment: "條款增修",
  annual_rollover: "跨年度",
};

export default function AnnouncementDetailPage() {
  const params = useParams<{ id: string }>();
  const announcementId = params.id;

  const [versions, setVersions] = useState<AnnouncementVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [signed, setSigned] = useState<AnnouncementAck[]>([]);
  const [pending, setPending] = useState<AnnouncementAck[]>([]);
  const [consentRate, setConsentRate] = useState<{ signed: number; total: number } | null>(null);
  const [sheets, setSheets] = useState<SignatureSheet[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadVersions = useCallback(async () => {
    try {
      const res = await getAnnouncementVersions(announcementId);
      setVersions(res.versions);
      setSelectedVersionId((prev) => prev ?? res.versions[res.versions.length - 1]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入版本失敗");
    }
  }, [announcementId]);

  const loadVersionDetail = useCallback(async () => {
    if (!selectedVersionId) return;
    try {
      const [acks, sh] = await Promise.all([
        getAnnouncementAcks(announcementId, selectedVersionId),
        getSignatureSheets(selectedVersionId),
      ]);
      setSigned(acks.signed);
      setPending(acks.pending);
      setConsentRate(acks.consentRate);
      setSheets(sh.sheets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入簽收失敗");
    }
  }, [announcementId, selectedVersionId]);

  useEffect(() => {
    void loadVersions();
    getEmployees()
      .then((e) => setEmployees(e.employees))
      .catch(() => null);
  }, [loadVersions]);

  useEffect(() => {
    void loadVersionDetail();
  }, [loadVersionDetail]);

  const selected = versions.find((v) => v.id === selectedVersionId) ?? null;
  const empName = (id: string) =>
    employees.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <PageHeader
        title="公告版本與簽收"
        desc="內容版本與簽署快照是兩條獨立的軸：有人補簽不會讓規章進版。"
      />

      <Card>
        <Link href="/admin/announcements" className="text-sm text-blue-600 underline">
          ← 回公告列表
        </Link>
        {error && <ErrorText>{error}</ErrorText>}
        {message && <p className="mt-3 text-sm text-green-700">{message}</p>}
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">內容版本鏈</h2>
        <p className="mb-4 text-xs text-gray-500">
          勞檢或訴訟時「請提出當時生效的第幾版」，答案在這裡。舊版內容不會被覆寫。
        </p>
        {versions.length === 0 ? (
          <Empty>尚無版本紀錄。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2">版</th>
                  <th className="py-2">進版原因</th>
                  <th className="py-2">生效期間</th>
                  <th className="py-2">需簽收</th>
                  <th className="py-2">不利益變更</th>
                  <th className="py-2">內容指紋</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr
                    key={v.id}
                    className={`border-b border-gray-100 ${
                      v.id === selectedVersionId ? "bg-blue-50" : ""
                    }`}
                  >
                    <td className="py-2 font-medium">第 {v.version_no} 版</td>
                    <td className="py-2 text-xs">
                      {CHANGE_LABEL[v.change_type]}
                      {v.change_note ? (
                        <span className="block text-gray-500">{v.change_note}</span>
                      ) : null}
                    </td>
                    <td className="py-2 text-xs">
                      {v.effective_from ?? "—"} ~ {v.effective_to ?? "仍生效"}
                    </td>
                    <td className="py-2 text-xs">{v.requires_signature ? "是" : "—"}</td>
                    <td className="py-2 text-xs">
                      {v.is_adverse_change ? (
                        <span className="rounded bg-red-100 px-2 py-0.5 text-red-800">是</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2">
                      <code className="text-xs text-gray-500">
                        {v.content_hash?.slice(0, 10) ?? "—"}
                      </code>
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedVersionId(v.id)}
                        className="text-xs text-blue-600 underline"
                      >
                        檢視
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && (
        <>
          <Card>
            <h2 className="mb-1 text-sm font-medium text-gray-500">
              第 {selected.version_no} 版 · 簽收盤點
            </h2>
            {selected.is_adverse_change ? (
              <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800">
                本版涉及<strong>勞動條件不利益變更</strong>。實務見解上，不利益變更原則上需
                勞工個別同意，否則對不同意者不生效力。下方「同意率」只計在職員工的
                「同意變更」，新人到職接受不列入分母也不列入分子——
                混算會讓同意率失真，而那個比率正是變更是否生效的關鍵事實。
              </p>
            ) : null}

            <div className="mb-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-lg border border-gray-200 p-4">
                <div className="text-xs text-gray-500">已簽</div>
                <div className="mt-1 text-2xl font-semibold">{signed.length}</div>
              </div>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                <div className="text-xs text-amber-800">尚未簽</div>
                <div className="mt-1 text-2xl font-semibold text-amber-900">
                  {pending.length}
                </div>
                <p className="mt-2 text-xs text-amber-800">
                  一張紙本傳閱單傳完，沒人知道少了誰。這裡知道。
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 p-4">
                <div className="text-xs text-gray-500">同意率（僅計同意變更）</div>
                <div className="mt-1 text-2xl font-semibold">
                  {consentRate ? `${consentRate.signed} / ${consentRate.total}` : "—"}
                </div>
              </div>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <section>
                <h3 className="mb-2 text-sm font-medium text-amber-900">尚未簽署</h3>
                {pending.length === 0 ? (
                  <Empty>全員皆已簽署。</Empty>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {pending.map((a) => (
                      <li
                        key={a.id}
                        className="rounded border border-amber-200 bg-amber-50 px-3 py-2"
                      >
                        {empName(a.employee_id)}
                        <span className="ml-2 text-xs text-amber-800">
                          {a.kind === "accept_on_hire" ? "到職接受" : "同意變更"}
                        </span>
                        {a.viewed_at ? (
                          <span className="ml-2 text-xs text-gray-500">
                            已查閱 {a.viewed_at.slice(0, 10)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium text-gray-800">已簽署</h3>
                {signed.length === 0 ? (
                  <Empty>尚無簽署紀錄。</Empty>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {signed.map((a) => (
                      <li key={a.id} className="rounded border border-gray-200 px-3 py-2">
                        {empName(a.employee_id)}
                        <span className="ml-2 text-xs text-gray-500">
                          {a.signed_at?.slice(0, 10)}
                        </span>
                        <span className="ml-2 text-xs text-gray-400">
                          {a.kind === "accept_on_hire" ? "到職接受" : "同意變更"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </Card>

          <PaperSignatureForm
            versionId={selected.id}
            employees={employees}
            onDone={(msg) => {
              setMessage(msg);
              void loadVersionDetail();
            }}
            onError={setError}
          />

          <Card>
            <h2 className="mb-1 text-sm font-medium text-gray-500">紙本簽名單掃描檔</h2>
            <p className="mb-4 text-xs leading-relaxed text-gray-500">
              補簽後<strong>加一份新的</strong>，不覆蓋舊檔——每一份都是「某時點誰已簽」的
              切片。覆蓋會讓那個時間軸消失，紙本一旦毀損也無從還原。
            </p>

            {sheets.length === 0 ? (
              <Empty>尚未上傳掃描檔。</Empty>
            ) : (
              <ul className="mb-4 space-y-1 text-sm">
                {sheets.map((s) => (
                  <li key={s.id} className="rounded border border-gray-200 px-3 py-2">
                    <span className="font-medium">第 {s.sheetNo} 份</span>
                    <span className="ml-2">{s.fileName}</span>
                    <span className="ml-2 text-xs text-gray-500">
                      {s.uploadedAt.slice(0, 10)}
                    </span>
                    {s.note ? (
                      <span className="ml-2 text-xs text-gray-500">· {s.note}</span>
                    ) : null}
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 text-xs text-blue-600 underline"
                      >
                        開啟
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            <SheetUploader
              versionId={selected.id}
              busy={busy}
              setBusy={setBusy}
              onDone={(msg) => {
                setMessage(msg);
                void loadVersionDetail();
              }}
              onError={setError}
            />
          </Card>
        </>
      )}
    </>
  );
}

/**
 * 登錄紙本簽署。`signedAt` 必須人工輸入：傳閱單頂上是公告日期，
 * 新人數月後在後續欄位補簽，那張紙不記錄他何時簽 —— 而不利益變更
 * 需要證明「每個人何時同意」。
 */
function PaperSignatureForm({
  versionId,
  employees,
  onDone,
  onError,
}: {
  versionId: string;
  employees: Employee[];
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [signedAt, setSignedAt] = useState(new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<"consent_to_change" | "accept_on_hire">(
    "consent_to_change",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await recordPaperSignature(versionId, {
        employeeId,
        kind,
        signedAt: new Date(`${signedAt}T00:00:00.000Z`).toISOString(),
        note: note.trim() || undefined,
      });
      setNote("");
      onDone("已登錄紙本簽署");
    } catch (err) {
      onError(err instanceof Error ? err.message : "登錄失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 text-sm font-medium text-gray-500">登錄紙本簽署</h2>
      <p className="mb-4 text-xs leading-relaxed text-gray-500">
        簽署日期請填<strong>實際簽名那天</strong>，不是公告日期。
        傳閱單頂上印的是公告日，補簽者何時簽那張紙看不出來；
        而不利益變更需要證明「每個人何時同意」。
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="sig-emp">
              員工
            </label>
            <select
              id="sig-emp"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              required
              className={inputCls}
            >
              <option value="">請選擇</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="sig-date">
              實際簽署日
            </label>
            <input
              id="sig-date"
              type="date"
              value={signedAt}
              onChange={(e) => setSignedAt(e.target.value)}
              required
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="sig-kind">
              簽名性質
            </label>
            <select
              id="sig-kind"
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as "consent_to_change" | "accept_on_hire")
              }
              className={inputCls}
            >
              <option value="consent_to_change">同意變更（在職員工）</option>
              <option value="accept_on_hire">到職接受（新進人員）</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="sig-note">
            備註（選填）
          </label>
          <input
            id="sig-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={250}
            className={inputCls}
          />
        </div>
        <PrimaryButton type="submit" disabled={busy || !employeeId}>
          {busy ? "登錄中…" : "登錄簽署"}
        </PrimaryButton>
      </form>
    </Card>
  );
}

function SheetUploader({
  versionId,
  busy,
  setBusy,
  onDone,
  onError,
}: {
  versionId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const res = await uploadSignatureSheet(versionId, file, note.trim() || undefined);
      setFile(null);
      setNote("");
      onDone(`已上傳第 ${res.sheetNo} 份掃描檔`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "上傳失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 border-t border-gray-200 pt-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="sheet-file">
            掃描檔
          </label>
          <input
            id="sheet-file"
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full text-sm"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="sheet-note">
            說明（例：補入 3 位新進同仁簽名）
          </label>
          <input
            id="sheet-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={250}
            className={inputCls}
          />
        </div>
      </div>
      <PrimaryButton type="submit" disabled={busy || !file}>
        {busy ? "上傳中…" : "新增一份掃描檔"}
      </PrimaryButton>
    </form>
  );
}
