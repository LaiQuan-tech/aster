"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, InlineError } from "@/components/ess-ui";
import { getMeCached } from "@/lib/ess-state";
import {
  getProfile,
  saveProfile,
  uploadProfilePhoto,
  deleteProfilePhoto,
  addEducation,
  addCertification,
  addWorkHistory,
  deleteEducation,
  deleteCertification,
  deleteWorkHistory,
  uploadEducationAttachment,
  deleteEducationAttachment,
  uploadCertificationAttachment,
  deleteCertificationAttachment,
  type ProfileAggregate,
  type SaveProfileBody,
} from "@/lib/ess-api";
import { accountErrorMessage, changeMyPassword } from "@/lib/auth-api";
import { listProfileChangeRequests, type ProfileChangeRequest } from "@/lib/people-extras-api";

const input =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const label = "mb-1 block text-xs font-medium text-gray-500";

// My Data 六分頁.
const TABS = ["基本資料", "通訊資料", "學歷證照", "工作經歷", "年資", "職務經歷"] as const;
type Tab = (typeof TABS)[number];

// 基本資料 fields (key = SaveProfileBody camelCase).
const BASIC_FIELDS: { key: keyof SaveProfileBody; label: string; type?: "date" }[] = [
  { key: "lastName", label: "姓" },
  { key: "firstName", label: "名" },
  { key: "englishName", label: "英文姓名" },
  { key: "nationality", label: "國籍" },
  { key: "gender", label: "性別" },
  { key: "idType", label: "證件類型" },
  { key: "idNumber", label: "證件號碼" },
  { key: "idExpiry", label: "證件到期日", type: "date" },
  { key: "idType2", label: "證件類型2" },
  { key: "idNumber2", label: "證件號碼2" },
  { key: "idExpiry2", label: "證件到期日2", type: "date" },
  { key: "idType3", label: "證件類型3" },
  { key: "idNumber3", label: "證件號碼3" },
  { key: "idExpiry3", label: "證件到期日3", type: "date" },
  { key: "entryDate", label: "入境時間", type: "date" },
  { key: "birthday", label: "生日", type: "date" },
  { key: "maritalStatus", label: "婚姻狀態" },
];

// 通訊資料 fields.
const CONTACT_FIELDS: { key: keyof SaveProfileBody; label: string; type?: "date" }[] = [
  { key: "phone", label: "電話(手機)" },
  { key: "phoneMobile2", label: "電話(手機2)" },
  { key: "phoneLandline", label: "電話(市話)" },
  { key: "registeredAddress", label: "戶籍地址" },
  { key: "address", label: "聯絡地址" },
  { key: "companyEmail", label: "公司信箱" },
  { key: "personalEmail", label: "私人信箱" },
  { key: "lineUserId", label: "LINE User ID" },
  { key: "emergencyContact", label: "緊急聯絡人" },
  { key: "emergencyRelationship", label: "緊急聯絡人關係" },
  { key: "emergencyPhone", label: "緊急聯絡人電話" },
];

// GET returns snake_case; map camelCase form key -> snake_case profile key.
const SNAKE: Record<string, string> = {
  firstName: "first_name",
  lastName: "last_name",
  englishName: "english_name",
  nationality: "nationality",
  idType: "id_type",
  idNumber: "id_number",
  idExpiry: "id_expiry",
  idType2: "id_type2",
  idNumber2: "id_number2",
  idExpiry2: "id_expiry2",
  idType3: "id_type3",
  idNumber3: "id_number3",
  idExpiry3: "id_expiry3",
  entryDate: "entry_date",
  birthday: "birthday",
  gender: "gender",
  maritalStatus: "marital_status",
  phone: "phone",
  phoneMobile2: "phone_mobile2",
  phoneLandline: "phone_landline",
  registeredAddress: "registered_address",
  address: "address",
  companyEmail: "company_email",
  personalEmail: "personal_email",
  lineUserId: "line_user_id",
  emergencyContact: "emergency_contact",
  emergencyRelationship: "emergency_relationship",
  emergencyPhone: "emergency_phone",
};

/**
 * 送審模式下的兩種回應（W6）：
 *   202 `{ changeRequestId }` → 已送出待 HR 核准，profile 還沒變；
 *   403 `field_not_editable`  → 這幾欄公司規定只能由 HR 改。
 * 沒開審核的租戶完全走原本的 200 路徑，畫面不變。
 */
function saveOutcomeMessage(res: { id?: string | null; changeRequestId?: string; changed?: number }): string {
  if (res.changeRequestId) return "已送出，等 HR 核准後才會更新";
  if (res.changed === 0) return "沒有變更";
  return "已儲存";
}

function ProfileFieldsForm({
  empId,
  data,
  fields,
  onSaved,
}: {
  empId: string;
  data: ProfileAggregate;
  fields: { key: keyof SaveProfileBody; label: string; type?: "date" }[];
  onSaved: () => Promise<void>;
}) {
  const initial = useMemo(() => {
    const v: Record<string, string> = {};
    for (const f of fields) {
      const raw = data.profile
        ? (data.profile as unknown as Record<string, string | null>)[SNAKE[f.key as string]]
        : null;
      v[f.key as string] = raw ?? "";
    }
    return v;
  }, [data, fields]);
  const [values, setValues] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => setValues(initial), [initial]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body: SaveProfileBody = {};
    for (const f of fields) {
      const v = (values[f.key as string] ?? "").trim();
      (body as Record<string, string | null>)[f.key as string] = v || null;
    }
    try {
      const res = (await saveProfile(empId, body)) as unknown as {
        id?: string | null;
        changeRequestId?: string;
        changed?: number;
      };
      setMsg(saveOutcomeMessage(res));
      await onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : "儲存失敗";
      setMsg(
        message.includes("field_not_editable")
          ? "這個分頁有欄位公司規定只能由 HR 修改，請洽人資"
          : message,
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {fields.map((f) => (
          <div key={f.key as string}>
            <label className={label}>{f.label}</label>
            <input
              className={input}
              type={f.type ?? "text"}
              value={values[f.key as string] ?? ""}
              onChange={(e) => setValues((p) => ({ ...p, [f.key as string]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: "var(--brand)" }}
        >
          儲存
        </button>
        {msg && <span className="text-sm text-green-600">{msg}</span>}
      </div>
    </form>
  );
}

/**
 * 「資料異動待審」橫幅（W6）：送出後到 HR 核准之前，員工看到的是**舊資料**——
 * 沒有這條橫幅會以為自己沒存成功、然後一直重送。列出每一筆待審的欄位與新值。
 * `refreshKey` 變動（每次重新載入 profile）就重查一次。
 */
function PendingChangesBanner({ refreshKey }: { refreshKey: unknown }) {
  const [rows, setRows] = useState<ProfileChangeRequest[]>([]);

  useEffect(() => {
    let active = true;
    listProfileChangeRequests("pending")
      .then((r) => {
        if (active) setRows(r.requests);
      })
      .catch(() => {
        if (active) setRows([]); // 表還沒建或沒開審核 → 當作沒有待審
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="text-sm font-medium text-amber-900">資料異動待 HR 核准</p>
      <ul className="mt-1 space-y-0.5 text-sm text-amber-800">
        {rows.flatMap((row) =>
          row.fields.map((field) => (
            <li key={`${row.id}-${field.column}`}>
              {field.label} → {String(field.to ?? "（清空）")}
            </li>
          )),
        )}
      </ul>
      <p className="mt-1 text-xs text-amber-700">核准之前，下方顯示的仍是原本的資料。</p>
    </div>
  );
}

export default function MyDataPage() {
  const [empId, setEmpId] = useState<string | null>(null);
  const [data, setData] = useState<ProfileAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("基本資料");

  // 學歷 add-form state
  const [showEduForm, setShowEduForm] = useState(false);
  const [eduProofFile, setEduProofFile] = useState<File | null>(null);
  const [edu, setEdu] = useState({
    school: "",
    degree: "",
    majorCategory: "",
    major: "",
    studyType: "日間部",
    studyStatus: "畢業",
    region: "",
    startDate: "",
    endDate: "",
    isHighest: false,
  });
  const [showCertForm, setShowCertForm] = useState(false);
  const [certAttachmentFile, setCertAttachmentFile] = useState<File | null>(null);
  const [cert, setCert] = useState({
    name: "",
    issuer: "",
    issuedDate: "",
    expiryDate: "",
  });
  const [showWorkForm, setShowWorkForm] = useState(false);
  const [work, setWork] = useState({
    company: "",
    title: "",
    startDate: "",
    endDate: "",
    description: "",
  });

  const load = useCallback(async (id: string) => {
    setData(await getProfile(id));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await getMeCached();
        if (!active) return;
        setEmpId(me.id);
        await load(me.id);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "載入失敗");
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function submitEdu(e: FormEvent) {
    e.preventDefault();
    if (!empId || !edu.school.trim()) return;
    const created = await addEducation(empId, {
      school: edu.school.trim(),
      isHighest: edu.isHighest,
      majorCategory: edu.majorCategory.trim() || undefined,
      major: edu.major.trim() || undefined,
      degree: edu.degree.trim() || undefined,
      studyType: edu.studyType,
      studyStatus: edu.studyStatus,
      region: edu.region.trim() || undefined,
      startDate: edu.startDate || undefined,
      endDate: edu.endDate || undefined,
    });
    if (eduProofFile) await uploadEducationAttachment(created.id, eduProofFile);
    setShowEduForm(false);
    setEduProofFile(null);
    setEdu({ school: "", degree: "", majorCategory: "", major: "", studyType: "日間部", studyStatus: "畢業", region: "", startDate: "", endDate: "", isHighest: false });
    await load(empId);
  }

  async function submitCert(e: FormEvent) {
    e.preventDefault();
    if (!empId) return;
    if (!cert.name.trim()) return;
    const created = await addCertification(empId, {
      name: cert.name.trim(),
      issuer: cert.issuer.trim() || undefined,
      issuedDate: cert.issuedDate || undefined,
      expiryDate: cert.expiryDate || undefined,
    });
    if (certAttachmentFile) await uploadCertificationAttachment(created.id, certAttachmentFile);
    setShowCertForm(false);
    setCertAttachmentFile(null);
    setCert({ name: "", issuer: "", issuedDate: "", expiryDate: "" });
    await load(empId);
  }

  async function onPhotoFile(file: File | null) {
    if (!empId || !file) return;
    await uploadProfilePhoto(empId, file);
    await load(empId);
  }

  async function removePhoto() {
    if (!empId) return;
    await deleteProfilePhoto(empId);
    await load(empId);
  }

  async function submitWork(e: FormEvent) {
    e.preventDefault();
    if (!empId) return;
    if (!work.company.trim()) return;
    await addWorkHistory(empId, {
      company: work.company.trim(),
      title: work.title.trim() || undefined,
      startDate: work.startDate || undefined,
      endDate: work.endDate || undefined,
      description: work.description.trim() || undefined,
    });
    setShowWorkForm(false);
    setWork({ company: "", title: "", startDate: "", endDate: "", description: "" });
    await load(empId);
  }

  async function removeItem(kind: "edu" | "cert" | "work", id: string) {
    if (!empId) return;
    if (kind === "edu") await deleteEducation(id);
    if (kind === "cert") await deleteCertification(id);
    if (kind === "work") await deleteWorkHistory(id);
    await load(empId);
  }

  const yearsLabel = (y: number | null) => (y == null ? "N/A" : y.toFixed(1));

  return (
    <div className="space-y-4">
      {error && <InlineError>{error}</InlineError>}
      <PendingChangesBanner refreshKey={data} />
      {!data ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : (
        <Card>
          {/* 六分頁 */}
          <nav className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-gray-100 px-1 pb-2 sm:flex-wrap sm:overflow-visible">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium sm:rounded-md sm:px-3 sm:py-1.5 ${tab === t ? "text-white" : "text-gray-600 hover:bg-gray-100"}`}
                style={tab === t ? { backgroundColor: "var(--brand)" } : undefined}
              >
                {t}
              </button>
            ))}
          </nav>

          {tab === "基本資料" && empId && (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-4 rounded-xl bg-gray-50 p-4">
                <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl bg-white text-lg font-semibold text-gray-500 ring-1 ring-gray-200">
                  {data.profile?.photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={data.profile.photo_url} alt="員工照片" className="h-full w-full object-cover" />
                  ) : (
                    data.basic.name.slice(0, 1)
                  )}
                </div>
                <dl className="grid flex-1 grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <dt className="text-gray-500">姓名</dt>
                  <dd className="font-medium">{data.basic.name}</dd>
                  <dt className="text-gray-500">員工編號</dt>
                  <dd>{data.basic.emp_no ?? "—"}</dd>
                  <dt className="text-gray-500">照片</dt>
                  <dd>{data.profile?.photo_file_name ?? "尚未上傳"}</dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <label className="cursor-pointer rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700">
                    上傳照片
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => void onPhotoFile(e.target.files?.[0] ?? null)} />
                  </label>
                  {data.profile?.photo_url && (
                    <button type="button" onClick={() => void removePhoto()} className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600">
                      刪除照片
                    </button>
                  )}
                </div>
              </div>
              <ProfileFieldsForm empId={empId} data={data} fields={BASIC_FIELDS} onSaved={() => load(empId)} />
            </>
          )}

          {tab === "通訊資料" && empId && (
            <ProfileFieldsForm empId={empId} data={data} fields={CONTACT_FIELDS} onSaved={() => load(empId)} />
          )}

          {tab === "學歷證照" && (
            <div className="space-y-6">
              <div>
                <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="font-semibold text-gray-800">學歷資料</h3>
                  <button onClick={() => setShowEduForm((s) => !s)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                    {showEduForm ? "收合" : "＋ 新增學歷"}
                  </button>
                </div>
                {showEduForm && (
                  <form onSubmit={submitEdu} className="mb-4 space-y-3 rounded-lg bg-gray-50 p-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <label className={label}>學校</label>
                        <input className={input} value={edu.school} onChange={(e) => setEdu({ ...edu, school: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>學歷類別</label>
                        <input className={input} placeholder="學士/碩士…" value={edu.degree} onChange={(e) => setEdu({ ...edu, degree: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>科系類別</label>
                        <input className={input} value={edu.majorCategory} onChange={(e) => setEdu({ ...edu, majorCategory: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>科系名稱</label>
                        <input className={input} value={edu.major} onChange={(e) => setEdu({ ...edu, major: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>就學類別</label>
                        <select className={input} value={edu.studyType} onChange={(e) => setEdu({ ...edu, studyType: e.target.value })}>
                          <option>日間部</option>
                          <option>夜間部</option>
                          <option>其他(進修部或在職專班)</option>
                        </select>
                      </div>
                      <div>
                        <label className={label}>就學狀態</label>
                        <select className={input} value={edu.studyStatus} onChange={(e) => setEdu({ ...edu, studyStatus: e.target.value })}>
                          <option>畢業</option>
                          <option>就學中</option>
                          <option>肄業</option>
                        </select>
                      </div>
                      <div>
                        <label className={label}>就學開始時間</label>
                        <input type="date" className={input} value={edu.startDate} onChange={(e) => setEdu({ ...edu, startDate: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>就學結束時間</label>
                        <input type="date" className={input} value={edu.endDate} onChange={(e) => setEdu({ ...edu, endDate: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>學校所在地區</label>
                        <input className={input} value={edu.region} onChange={(e) => setEdu({ ...edu, region: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>證明文件</label>
                        <input type="file" className={input} onChange={(e) => setEduProofFile(e.target.files?.[0] ?? null)} />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={edu.isHighest} onChange={(e) => setEdu({ ...edu, isHighest: e.target.checked })} />
                      最高學歷
                    </label>
                    <button type="submit" className="rounded-md px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: "var(--brand)" }}>
                      新增
                    </button>
                  </form>
                )}
                <ul className="divide-y divide-gray-100">
                  {data.educations.map((e) => (
                    <li key={e.id} className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <span>
                        <span className="font-medium text-gray-800">{e.school}</span>{" "}
                        <span className="text-gray-500">{[e.degree, e.major, e.study_status].filter(Boolean).join(" · ")}</span>
                        {e.is_highest && <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">最高學歷</span>}
                        {e.proof_url && (
                          <a className="ml-2 text-xs font-medium" style={{ color: "var(--brand)" }} href={e.proof_url} target="_blank" rel="noreferrer">
                            證明文件
                          </a>
                        )}
                      </span>
                      <div className="flex gap-2">
                        {e.proof_url && <button onClick={() => empId && deleteEducationAttachment(e.id).then(() => load(empId))} className="text-gray-500 hover:underline">刪附件</button>}
                        <button onClick={() => removeItem("edu", e.id)} className="text-red-600 hover:underline">
                          刪除
                        </button>
                      </div>
                    </li>
                  ))}
                  {data.educations.length === 0 && !showEduForm && <li className="py-2 text-sm text-gray-400">尚無學歷資料</li>}
                </ul>
              </div>
              <div>
                <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="font-semibold text-gray-800">證照資料</h3>
                  <button onClick={() => setShowCertForm((s) => !s)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                    {showCertForm ? "收合" : "＋ 新增證照"}
                  </button>
                </div>
                {showCertForm && (
                  <form onSubmit={submitCert} className="mb-4 space-y-3 rounded-lg bg-gray-50 p-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className={label}>證照名稱</label>
                        <input className={input} value={cert.name} onChange={(e) => setCert({ ...cert, name: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>發證單位</label>
                        <input className={input} value={cert.issuer} onChange={(e) => setCert({ ...cert, issuer: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>發證日期</label>
                        <input type="date" className={input} value={cert.issuedDate} onChange={(e) => setCert({ ...cert, issuedDate: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>到期日期</label>
                        <input type="date" className={input} value={cert.expiryDate} onChange={(e) => setCert({ ...cert, expiryDate: e.target.value })} />
                      </div>
                      <div>
                        <label className={label}>附件</label>
                        <input type="file" className={input} onChange={(e) => setCertAttachmentFile(e.target.files?.[0] ?? null)} />
                      </div>
                    </div>
                    <button type="submit" className="rounded-md px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: "var(--brand)" }}>
                      新增
                    </button>
                  </form>
                )}
                <ul className="divide-y divide-gray-100">
                  {data.certifications.map((c) => (
                    <li key={c.id} className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <span>
                        <span className="font-medium text-gray-800">{c.name}</span>{" "}
                        <span className="text-gray-500">
                          {[c.issuer, [c.issued_date, c.expiry_date].filter(Boolean).join(" ~ ")].filter(Boolean).join(" · ")}
                        </span>
                        {c.attachment_url && (
                          <a className="ml-2 text-xs font-medium" style={{ color: "var(--brand)" }} href={c.attachment_url} target="_blank" rel="noreferrer">
                            附件
                          </a>
                        )}
                      </span>
                      <div className="flex gap-2">
                        {c.attachment_url && <button onClick={() => empId && deleteCertificationAttachment(c.id).then(() => load(empId))} className="text-gray-500 hover:underline">刪附件</button>}
                        <button onClick={() => removeItem("cert", c.id)} className="text-red-600 hover:underline">
                          刪除
                        </button>
                      </div>
                    </li>
                  ))}
                  {data.certifications.length === 0 && <li className="py-2 text-sm text-gray-400">尚無證照資料</li>}
                </ul>
              </div>
            </div>
          )}

          {tab === "工作經歷" && (
            <div>
              <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="font-semibold text-gray-800">工作經歷</h3>
                <button onClick={() => setShowWorkForm((s) => !s)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                  {showWorkForm ? "收合" : "＋ 新增經歷"}
                </button>
              </div>
              {showWorkForm && (
                <form onSubmit={submitWork} className="mb-4 space-y-3 rounded-lg bg-gray-50 p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className={label}>公司</label>
                      <input className={input} value={work.company} onChange={(e) => setWork({ ...work, company: e.target.value })} />
                    </div>
                    <div>
                      <label className={label}>職稱</label>
                      <input className={input} value={work.title} onChange={(e) => setWork({ ...work, title: e.target.value })} />
                    </div>
                    <div>
                      <label className={label}>開始日期</label>
                      <input type="date" className={input} value={work.startDate} onChange={(e) => setWork({ ...work, startDate: e.target.value })} />
                    </div>
                    <div>
                      <label className={label}>結束日期</label>
                      <input type="date" className={input} value={work.endDate} onChange={(e) => setWork({ ...work, endDate: e.target.value })} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className={label}>說明</label>
                      <textarea className={input} rows={3} value={work.description} onChange={(e) => setWork({ ...work, description: e.target.value })} />
                    </div>
                  </div>
                  <button type="submit" className="rounded-md px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: "var(--brand)" }}>
                    新增
                  </button>
                </form>
              )}
              <ul className="divide-y divide-gray-100">
                {data.workHistory.map((w) => (
                  <li key={w.id} className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span>
                      <span className="font-medium text-gray-800">{w.company}</span>{" "}
                      <span className="text-gray-500">
                        {[w.title, [w.start_date, w.end_date].filter(Boolean).join(" ~ ")].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <button onClick={() => removeItem("work", w.id)} className="text-red-600 hover:underline">
                      刪除
                    </button>
                  </li>
                ))}
                {data.workHistory.length === 0 && <li className="py-2 text-sm text-gray-400">尚無工作經歷</li>}
              </ul>
            </div>
          )}

          {tab === "年資" && (
            <dl className="grid max-w-sm grid-cols-2 gap-3 text-sm">
              <dt className="text-gray-500">內部年資</dt>
              <dd className="font-medium">{yearsLabel(data.seniority.internalYears)}</dd>
              <dt className="text-gray-500">職等年資</dt>
              <dd className="font-medium">{yearsLabel(data.seniority.gradeYears)}</dd>
              <dt className="text-gray-500">單位年資</dt>
              <dd className="font-medium">{yearsLabel(data.seniority.unitYears)}</dd>
            </dl>
          )}

          {tab === "職務經歷" && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="py-2 pr-4">生效日期</th>
                    <th className="py-2 pr-4">異動行為</th>
                    <th className="py-2 pr-4">直屬單位</th>
                    <th className="py-2 pr-4">職等</th>
                    <th className="py-2">職稱</th>
                  </tr>
                </thead>
                <tbody>
                  {data.jobHistory.map((j) => (
                    <tr key={j.id} className="border-b border-gray-50">
                      <td className="py-2 pr-4">{j.effective_date}</td>
                      <td className="py-2 pr-4">{j.action}</td>
                      <td className="py-2 pr-4">{j.dept_name ?? "—"}</td>
                      <td className="py-2 pr-4">{j.grade ?? "—"}</td>
                      <td className="py-2">{j.title ?? "—"}</td>
                    </tr>
                  ))}
                  {data.jobHistory.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-gray-400">
                        尚無職務異動紀錄
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <ChangePasswordCard />
    </div>
  );
}

/** 修改密碼：用目前密碼驗證身分，再設新密碼（POST /me/password）。 */
function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    if (next.length < 8) {
      setErr("新密碼至少 8 碼");
      return;
    }
    if (next !== confirm) {
      setErr("兩次輸入的新密碼不一致");
      return;
    }
    if (next === current) {
      setErr("新密碼不可與目前密碼相同");
      return;
    }
    setBusy(true);
    try {
      await changeMyPassword(current, next);
      setMsg("密碼已更新，下次登入請使用新密碼。");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      setErr(accountErrorMessage(e, "修改密碼失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="修改密碼">
      <p className="mb-4 text-xs text-gray-500">請先輸入目前密碼確認身分；新密碼至少 8 碼。忘記目前密碼可登出後在登入頁點「忘記密碼？」。</p>
      <form onSubmit={onSubmit} className="grid max-w-md grid-cols-1 gap-3">
        <div>
          <label className={label} htmlFor="pw-current">目前密碼</label>
          <input id="pw-current" type="password" autoComplete="current-password" required className={input} value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pw-next">新密碼</label>
          <input id="pw-next" type="password" autoComplete="new-password" required minLength={8} className={input} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pw-confirm">再輸入一次新密碼</label>
          <input id="pw-confirm" type="password" autoComplete="new-password" required minLength={8} className={input} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
        {msg && <p className="text-sm text-green-700" role="status">{msg}</p>}
        <button type="submit" disabled={busy} className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60 sm:w-auto" style={{ backgroundColor: "var(--brand)" }}>
          {busy ? "更新中…" : "更新密碼"}
        </button>
      </form>
    </Card>
  );
}
