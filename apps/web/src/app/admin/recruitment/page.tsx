"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import {
  createAnnouncement,
  createCandidate,
  createInterview,
  createJobRequisition,
  createOffer,
  deleteJobRequisition,
  getCandidates,
  getDepartments,
  getEmployees,
  getInterviews,
  getJobRequisitions,
  getOffers,
  updateCandidate,
  updateInterview,
  updateJobRequisition,
  updateOffer,
  type Candidate,
  type Department,
  type Employee,
  type Interview,
  type JobRequisition,
  type Offer,
} from "@/lib/admin-api";

const REQ_STATUS_LABEL: Record<JobRequisition["status"], string> = {
  draft: "草稿",
  pending_approval: "待審核",
  open: "開放中",
  closed: "已關閉",
};

const CAND_STATUS_LABEL: Record<Candidate["status"], string> = {
  new: "新進人才",
  screening: "履歷篩選",
  interviewing: "面試中",
  offered: "已發 Offer",
  hired: "已錄用",
  rejected: "不適合",
};

const OFFER_LABEL: Record<Offer["status"], string> = {
  draft: "草稿/待審",
  approved: "已核准",
  sent: "已寄出",
  accepted: "已接受",
  declined: "已婉拒",
};

const CAND_STATUSES = Object.keys(CAND_STATUS_LABEL) as Candidate["status"][];
const OFFER_STATUSES = Object.keys(OFFER_LABEL) as Offer["status"][];

function toIsoFromLocal(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

function downloadRecruitmentReport(
  reqs: JobRequisition[],
  cands: Candidate[],
  interviews: Interview[],
  offers: Offer[],
) {
  const rows = [
    ["類型", "項目", "數量"],
    ["職缺", "總職缺", String(reqs.length)],
    ["職缺", "開放中", String(reqs.filter((item) => item.status === "open").length)],
    ["職缺", "待審核", String(reqs.filter((item) => item.status === "pending_approval").length)],
    ["人才", "總人才", String(cands.length)],
    ...CAND_STATUSES.map((status) => ["人才狀態", CAND_STATUS_LABEL[status], String(cands.filter((item) => item.status === status).length)]),
    ["面試", "已排程", String(interviews.filter((item) => item.scheduled_at).length)],
    ["面試", "通過", String(interviews.filter((item) => item.result === "pass").length)],
    ["面試", "未通過", String(interviews.filter((item) => item.result === "fail").length)],
    ...OFFER_STATUSES.map((status) => ["錄用狀態", OFFER_LABEL[status], String(offers.filter((item) => item.status === status).length)]),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${cell.replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `recruitment-report-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function RecruitmentPage() {
  const [reqs, setReqs] = useState<JobRequisition[]>([]);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [reqFilterStatus, setReqFilterStatus] = useState<"" | JobRequisition["status"]>("");
  const [candidateFilterStatus, setCandidateFilterStatus] = useState<"" | Candidate["status"]>("");
  const [interviewerFilter, setInterviewerFilter] = useState("");

  const [title, setTitle] = useState("");
  const [deptId, setDeptId] = useState("");
  const [employmentType, setEmploymentType] = useState("regular");
  const [headcount, setHeadcount] = useState("1");
  const [description, setDescription] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(true);

  const [candName, setCandName] = useState("");
  const [candEmail, setCandEmail] = useState("");
  const [candPhone, setCandPhone] = useState("");
  const [candSource, setCandSource] = useState("");
  const [candResumeUrl, setCandResumeUrl] = useState("");
  const [candNote, setCandNote] = useState("");
  const [candReq, setCandReq] = useState("");

  const [interviewCandidateId, setInterviewCandidateId] = useState("");
  const [interviewerEmpId, setInterviewerEmpId] = useState("");
  const [interviewAt, setInterviewAt] = useState("");
  const [interviewStage, setInterviewStage] = useState("一面");

  const [offerCandidateId, setOfferCandidateId] = useState("");
  const [offerSalary, setOfferSalary] = useState("");
  const [offerStartDate, setOfferStartDate] = useState("");
  const [offerNote, setOfferNote] = useState("");

  const deptName = useMemo(() => new Map(departments.map((dept) => [dept.id, dept.name])), [departments]);
  const employeeName = useMemo(() => {
    return new Map(employees.map((employee) => [employee.id, employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name]));
  }, [employees]);

  const filteredReqs = useMemo(() => {
    return reqs.filter((req) => !reqFilterStatus || req.status === reqFilterStatus);
  }, [reqFilterStatus, reqs]);

  const filteredCandidates = useMemo(() => {
    return cands.filter((candidate) => !candidateFilterStatus || candidate.status === candidateFilterStatus);
  }, [candidateFilterStatus, cands]);

  const filteredInterviews = useMemo(() => {
    return interviews.filter((interview) => !interviewerFilter || interview.interviewer_emp_id === interviewerFilter);
  }, [interviewerFilter, interviews]);

  const reqTitle = useCallback((id: string | null) => reqs.find((req) => req.id === id)?.title ?? "—", [reqs]);
  const candidateLabel = useCallback((id: string) => cands.find((candidate) => candidate.id === id)?.name ?? id.slice(0, 8), [cands]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reqRes, candRes, interviewRes, offerRes, deptRes, empRes] = await Promise.all([
        getJobRequisitions(),
        getCandidates(),
        getInterviews(),
        getOffers(),
        getDepartments(),
        getEmployees(),
      ]);
      setReqs(reqRes["job-requisitions"]);
      setCands(candRes.candidates);
      setInterviews(interviewRes.interviews);
      setOffers(offerRes.offers);
      setDepartments(deptRes.departments);
      setEmployees(empRes.employees);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入招募資料失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreateReq(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setMessage(null);
    setError(null);
    try {
      await createJobRequisition({
        title: title.trim(),
        deptId: deptId || null,
        employmentType,
        headcount: Number(headcount) || 1,
        description: description.trim() || undefined,
        isInternal,
        status: needsApproval ? "pending_approval" : "open",
      });
      setTitle("");
      setDeptId("");
      setEmploymentType("regular");
      setHeadcount("1");
      setDescription("");
      setIsInternal(false);
      setMessage(needsApproval ? "職缺需求單已送審" : "職缺已建立並開放");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增職缺失敗");
    }
  }

  async function publishJob(req: JobRequisition) {
    setBusyId(req.id);
    setMessage(null);
    setError(null);
    try {
      await createAnnouncement({
        title: `職缺公告｜${req.title}`,
        audience: req.is_internal ? "internal_jobs" : "recruitment",
        body: [
          `職缺：${req.title}`,
          `部門：${req.dept_id ? (deptName.get(req.dept_id) ?? "未命名部門") : "未指定"}`,
          `需求人數：${req.headcount}`,
          `用工型態：${req.employment_type}`,
          req.description ? `說明：${req.description}` : "",
        ].filter(Boolean).join("\n"),
      });
      setMessage("職缺公告已發布到公告管理");
    } catch (err) {
      setError(err instanceof Error ? err.message : "發布公告失敗");
    } finally {
      setBusyId(null);
    }
  }

  async function onCreateCand(event: FormEvent) {
    event.preventDefault();
    if (!candName.trim()) return;
    setMessage(null);
    setError(null);
    try {
      await createCandidate({
        name: candName.trim(),
        email: candEmail.trim() || undefined,
        phone: candPhone.trim() || undefined,
        source: candSource.trim() || undefined,
        resumeUrl: candResumeUrl.trim() || undefined,
        note: candNote.trim() || undefined,
        requisitionId: candReq || undefined,
      });
      setCandName("");
      setCandEmail("");
      setCandPhone("");
      setCandSource("");
      setCandResumeUrl("");
      setCandNote("");
      setCandReq("");
      setMessage("人才已加入人才庫");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增人才失敗");
    }
  }

  async function onCreateInterview(event: FormEvent) {
    event.preventDefault();
    if (!interviewCandidateId) return;
    try {
      await createInterview({
        candidateId: interviewCandidateId,
        interviewerEmpId: interviewerEmpId || null,
        scheduledAt: toIsoFromLocal(interviewAt),
        stage: interviewStage.trim() || undefined,
      });
      await updateCandidate(interviewCandidateId, { status: "interviewing" });
      setInterviewCandidateId("");
      setInterviewerEmpId("");
      setInterviewAt("");
      setInterviewStage("一面");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "安排面試失敗");
    }
  }

  async function recordInterview(id: string, result: "pass" | "fail") {
    const notes = window.prompt("面試紀錄（可留空）") ?? "";
    try {
      await updateInterview(id, { result, notes: notes || null });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新面試紀錄失敗");
    }
  }

  async function onCreateOffer(event: FormEvent) {
    event.preventDefault();
    if (!offerCandidateId) return;
    try {
      await createOffer({
        candidateId: offerCandidateId,
        salary: offerSalary ? Number(offerSalary) : undefined,
        startDate: offerStartDate || undefined,
        note: offerNote.trim() || undefined,
      });
      await updateCandidate(offerCandidateId, { status: "offered" });
      setOfferCandidateId("");
      setOfferSalary("");
      setOfferStartDate("");
      setOfferNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "建立錄用申請失敗");
    }
  }

  async function setOfferStatus(offer: Offer, status: Offer["status"]) {
    await updateOffer(offer.id, { status });
    if (status === "accepted") await updateCandidate(offer.candidate_id, { status: "hired" });
    if (status === "declined") await updateCandidate(offer.candidate_id, { status: "rejected" });
    await load();
  }

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      {message && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">{message}</p>}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-gray-500">招募報表中心</h2>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                { label: "職缺", value: reqs.length },
                { label: "開放中", value: reqs.filter((item) => item.status === "open").length },
                { label: "人才", value: cands.length },
                { label: "面試", value: interviews.length },
                { label: "待審", value: reqs.filter((item) => item.status === "pending_approval").length + offers.filter((item) => item.status === "draft").length },
              ].map((item) => (
                <div key={item.label} className="rounded-xl bg-gray-50 px-4 py-3">
                  <p className="text-xs text-gray-500">{item.label}</p>
                  <p className="mt-1 text-2xl font-bold text-gray-900">{item.value}</p>
                </div>
              ))}
            </div>
          </div>
          <PrimaryButton onClick={() => downloadRecruitmentReport(reqs, cands, interviews, offers)}>下載報表</PrimaryButton>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">新增職缺需求單</h2>
        <form onSubmit={onCreateReq} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-6">
            <div className="lg:col-span-2">
              <label className={labelCls}>職缺名稱</label>
              <input className={inputCls} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="後端工程師" />
            </div>
            <div>
              <label className={labelCls}>部門</label>
              <select className={inputCls} value={deptId} onChange={(event) => setDeptId(event.target.value)}>
                <option value="">未指定</option>
                {departments.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>用工型態</label>
              <select className={inputCls} value={employmentType} onChange={(event) => setEmploymentType(event.target.value)}>
                <option value="regular">正職</option>
                <option value="contract">約聘</option>
                <option value="part_time">兼職</option>
                <option value="intern">實習</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>需求人數</label>
              <input className={inputCls} type="number" min={1} value={headcount} onChange={(event) => setHeadcount(event.target.value)} />
            </div>
            <div className="flex items-end">
              <PrimaryButton type="submit">送出職缺</PrimaryButton>
            </div>
            <div className="lg:col-span-6">
              <label className={labelCls}>職缺說明 / 公告文案</label>
              <textarea className={`${inputCls} h-24`} value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isInternal} onChange={(event) => setIsInternal(event.target.checked)} />
              內部職缺
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={needsApproval} onChange={(event) => setNeedsApproval(event.target.checked)} />
              送審核
            </label>
          </div>
        </form>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>職缺狀態</label>
            <select className={inputCls} value={reqFilterStatus} onChange={(event) => setReqFilterStatus(event.target.value as "" | JobRequisition["status"])}>
              <option value="">全部</option>
              {Object.entries(REQ_STATUS_LABEL).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
            </select>
          </div>
        </div>
        <h2 className="mb-4 text-sm font-medium text-gray-500">職缺列表 / 公告管理</h2>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : filteredReqs.length === 0 ? (
          <Empty>尚無職缺</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">職缺</th>
                  <th className="py-2 pr-4">部門/型態</th>
                  <th className="py-2 pr-4">人數</th>
                  <th className="py-2 pr-4">狀態</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredReqs.map((req) => (
                  <tr key={req.id} className="border-b border-gray-50 align-top">
                    <td className="max-w-sm py-3 pr-4">
                      <p className="font-medium text-gray-800">{req.title}</p>
                      {req.description && <p className="mt-1 line-clamp-2 text-xs text-gray-400">{req.description}</p>}
                      {req.is_internal && <span className="mt-1 inline-block rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">內部職缺</span>}
                    </td>
                    <td className="py-3 pr-4 text-gray-600">{req.dept_id ? deptName.get(req.dept_id) : "未指定"} / {req.employment_type}</td>
                    <td className="py-3 pr-4">{req.headcount}</td>
                    <td className="py-3 pr-4">{REQ_STATUS_LABEL[req.status]}</td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        {req.status === "pending_approval" && (
                          <>
                            <button onClick={() => updateJobRequisition(req.id, { status: "open" }).then(load)} className="rounded-md border border-green-300 px-3 py-1.5 text-xs text-green-700">核准</button>
                            <button onClick={() => updateJobRequisition(req.id, { status: "draft" }).then(load)} className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700">退回</button>
                          </>
                        )}
                        <button onClick={() => updateJobRequisition(req.id, { status: req.status === "open" ? "closed" : "open" }).then(load)} className="rounded-md border px-3 py-1.5 text-xs">
                          {req.status === "open" ? "關閉" : "開放"}
                        </button>
                        <button disabled={busyId === req.id} onClick={() => void publishJob(req)} className="rounded-md border border-blue-300 px-3 py-1.5 text-xs text-blue-700 disabled:opacity-50">發布公告</button>
                        <button onClick={() => deleteJobRequisition(req.id).then(load)} className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700">刪除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">新增人才 / 履歷資料</h2>
        <form onSubmit={onCreateCand} className="grid grid-cols-1 gap-4 lg:grid-cols-6">
          <div>
            <label className={labelCls}>姓名</label>
            <input className={inputCls} value={candName} onChange={(event) => setCandName(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input className={inputCls} value={candEmail} onChange={(event) => setCandEmail(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>電話</label>
            <input className={inputCls} value={candPhone} onChange={(event) => setCandPhone(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>來源</label>
            <input className={inputCls} value={candSource} onChange={(event) => setCandSource(event.target.value)} placeholder="104 / LinkedIn / 內推" />
          </div>
          <div>
            <label className={labelCls}>對應職缺</label>
            <select className={inputCls} value={candReq} onChange={(event) => setCandReq(event.target.value)}>
              <option value="">不指定</option>
              {reqs.map((req) => <option key={req.id} value={req.id}>{req.title}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <PrimaryButton type="submit">加入人才庫</PrimaryButton>
          </div>
          <div className="lg:col-span-3">
            <label className={labelCls}>履歷連結</label>
            <input className={inputCls} value={candResumeUrl} onChange={(event) => setCandResumeUrl(event.target.value)} />
          </div>
          <div className="lg:col-span-3">
            <label className={labelCls}>備註</label>
            <input className={inputCls} value={candNote} onChange={(event) => setCandNote(event.target.value)} />
          </div>
        </form>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>人才狀態</label>
            <select className={inputCls} value={candidateFilterStatus} onChange={(event) => setCandidateFilterStatus(event.target.value as "" | Candidate["status"])}>
              <option value="">全部</option>
              {CAND_STATUSES.map((status) => <option key={status} value={status}>{CAND_STATUS_LABEL[status]}</option>)}
            </select>
          </div>
        </div>
        <h2 className="mb-4 text-sm font-medium text-gray-500">人才庫</h2>
        {filteredCandidates.length === 0 ? (
          <Empty>尚無人才</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filteredCandidates.map((candidate) => (
              <li key={candidate.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="font-medium text-gray-800">{candidate.name} <span className="text-xs text-gray-400">{candidate.email ?? ""}</span></p>
                  <p className="text-xs text-gray-500">
                    {reqTitle(candidate.requisition_id)}｜{candidate.phone ?? "無電話"}｜{candidate.source ?? "無來源"}
                    {candidate.resume_url && <>｜<a href={candidate.resume_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">履歷</a></>}
                  </p>
                  {candidate.note && <p className="text-xs text-gray-400">{candidate.note}</p>}
                </div>
                <select className="rounded-md border border-gray-300 px-2 py-1 text-sm" value={candidate.status} onChange={(event) => updateCandidate(candidate.id, { status: event.target.value as Candidate["status"] }).then(load)}>
                  {CAND_STATUSES.map((status) => <option key={status} value={status}>{CAND_STATUS_LABEL[status]}</option>)}
                </select>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">面試紀錄表 / 面試行事曆</h2>
        <form onSubmit={onCreateInterview} className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div>
            <label className={labelCls}>候選人</label>
            <select className={inputCls} value={interviewCandidateId} onChange={(event) => setInterviewCandidateId(event.target.value)}>
              <option value="">請選擇</option>
              {cands.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>面試官</label>
            <select className={inputCls} value={interviewerEmpId} onChange={(event) => setInterviewerEmpId(event.target.value)}>
              <option value="">未指定</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employeeName.get(employee.id)}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>時間</label>
            <input type="datetime-local" className={inputCls} value={interviewAt} onChange={(event) => setInterviewAt(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>階段</label>
            <input className={inputCls} value={interviewStage} onChange={(event) => setInterviewStage(event.target.value)} />
          </div>
          <div className="flex items-end">
            <PrimaryButton type="submit">安排面試</PrimaryButton>
          </div>
        </form>

        <div className="mb-4">
          <label className={labelCls}>行事曆篩選：面試官</label>
          <select className={inputCls} value={interviewerFilter} onChange={(event) => setInterviewerFilter(event.target.value)}>
            <option value="">公司面試行事曆</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employeeName.get(employee.id)}</option>)}
          </select>
        </div>

        {filteredInterviews.length === 0 ? (
          <Empty>尚無面試</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filteredInterviews.map((interview) => (
              <li key={interview.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="font-medium text-gray-800">
                    {candidateLabel(interview.candidate_id)}｜{interview.scheduled_at ? interview.scheduled_at.replace("T", " ").slice(0, 16) : "未定時間"}
                  </p>
                  <p className="text-xs text-gray-500">
                    {interview.stage ?? "未指定階段"}｜面試官 {interview.interviewer_emp_id ? employeeName.get(interview.interviewer_emp_id) : "未指定"}
                    {interview.notes ? `｜${interview.notes}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-1 text-xs ${interview.result === "pass" ? "bg-green-100 text-green-700" : interview.result === "fail" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                    {interview.result === "pending" ? "待面試" : interview.result === "pass" ? "通過" : "未通過"}
                  </span>
                  {interview.result === "pending" && (
                    <>
                      <button onClick={() => void recordInterview(interview.id, "pass")} className="rounded-md border border-green-300 px-3 py-1.5 text-xs text-green-700">通過</button>
                      <button onClick={() => void recordInterview(interview.id, "fail")} className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700">未通過</button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">錄用申請單 / 錄用通知單查詢</h2>
        <form onSubmit={onCreateOffer} className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div>
            <label className={labelCls}>候選人</label>
            <select className={inputCls} value={offerCandidateId} onChange={(event) => setOfferCandidateId(event.target.value)}>
              <option value="">請選擇</option>
              {cands.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>核薪</label>
            <input type="number" className={inputCls} value={offerSalary} onChange={(event) => setOfferSalary(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>預計到職日</label>
            <input type="date" className={inputCls} value={offerStartDate} onChange={(event) => setOfferStartDate(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>備註</label>
            <input className={inputCls} value={offerNote} onChange={(event) => setOfferNote(event.target.value)} />
          </div>
          <div className="flex items-end">
            <PrimaryButton type="submit">建立錄用申請</PrimaryButton>
          </div>
        </form>
        {offers.length === 0 ? (
          <Empty>尚無錄用單</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {offers.map((offer) => (
              <li key={offer.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="font-medium text-gray-800">{candidateLabel(offer.candidate_id)} <span className="text-xs text-gray-500">核薪 {offer.salary ?? "—"}</span></p>
                  <p className="text-xs text-gray-500">到職 {offer.start_date ?? "未定"}｜{offer.note ?? "無備註"}</p>
                </div>
                <select className="rounded-md border border-gray-300 px-2 py-1 text-sm" value={offer.status} onChange={(event) => void setOfferStatus(offer, event.target.value as Offer["status"])}>
                  {OFFER_STATUSES.map((status) => <option key={status} value={status}>{OFFER_LABEL[status]}</option>)}
                </select>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
