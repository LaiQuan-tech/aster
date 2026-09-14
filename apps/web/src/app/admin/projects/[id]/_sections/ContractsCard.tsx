"use client";

import type { RefObject } from "react";
import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  uploadProjectDocument,
  type ProjectDocument,
  createContract,
  updateContract,
  deleteContract,
  DOC_TYPE_LABELS,
  OUR_ROLE_LABELS,
  OUR_ROLE_SHORT_LABELS,
  type Contract,
  type DocType,
  type OurRole,
} from "@/lib/projects-api";
import type { ProjectDetail } from "@/lib/projects-ext-api";
import { fmtMoney, humanError, type Setter } from "./shared";

interface ContractsCardProps {
  projectId: string;
  project: ProjectDetail;
  contracts: Contract[];
  /** 掃描檔依合約 id 分組（page.tsx 算好傳入；作廢合約的掃描檔不在這裡，退回專案文件區）。 */
  scansByContract: Map<string, ProjectDocument[]>;
  cDocType: DocType;
  setCDocType: Setter<DocType>;
  cOurRole: OurRole;
  setCOurRole: Setter<OurRole>;
  cTitle: string;
  setCTitle: Setter<string>;
  cCounterparty: string;
  setCCounterparty: Setter<string>;
  cAmount: string;
  setCAmount: Setter<string>;
  cSignedOn: string;
  setCSignedOn: Setter<string>;
  cCopies: string;
  setCCopies: Setter<string>;
  savingContract: boolean;
  setSavingContract: Setter<boolean>;
  contractFileRef: RefObject<HTMLInputElement | null>;
  pendingContractId: RefObject<string | null>;
  removeDoc: (doc: ProjectDocument) => Promise<void>;
  error: string | null;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/** 合約與報價單（模組四第 3 條）：列表／印花稅貼花／掃描檔／作廢，以及新增文件表單。 */
export function ContractsCard({
  projectId,
  project,
  contracts,
  scansByContract,
  cDocType,
  setCDocType,
  cOurRole,
  setCOurRole,
  cTitle,
  setCTitle,
  cCounterparty,
  setCCounterparty,
  cAmount,
  setCAmount,
  cSignedOn,
  setCSignedOn,
  cCopies,
  setCCopies,
  savingContract,
  setSavingContract,
  contractFileRef,
  pendingContractId,
  removeDoc,
  error,
  setError,
  load,
}: ContractsCardProps) {
  async function addContract() {
    if (!cTitle.trim()) {
      setError("請輸入文件名稱");
      return;
    }
    setSavingContract(true);
    setError(null);
    try {
      await createContract(projectId, {
        docType: cDocType,
        ourRole: cOurRole,
        title: cTitle.trim(),
        counterparty: cCounterparty.trim() || null,
        amount: cAmount === "" ? null : Number(cAmount),
        signedOn: cSignedOn || null,
        copies: Number(cCopies) || 1,
      });
      setCTitle("");
      setCCounterparty("");
      setCAmount("");
      setCSignedOn("");
      setCCopies("1");
      await load();
    } catch (err) {
      setError(humanError(err, "新增文件失敗"));
    } finally {
      setSavingContract(false);
    }
  }

  async function markStamped(c: Contract, paidOn: string | null) {
    setError(null);
    try {
      await updateContract(c.id, { stampDutyPaidOn: paidOn });
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  /** B1：貼花方式三選一——我方貼／對方貼／各自貼。簽約後常常才確認，
   * 後端 PATCH 會連同印花稅額一起重算。 */
  async function changeOurRole(c: Contract, ourRole: OurRole) {
    if (ourRole === c.ourRole) return;
    setError(null);
    try {
      await updateContract(c.id, { ourRole });
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  /** B1：「不用貼」開關——on 時強制 stampDutyRequired='no'（§6 免稅憑證等
   * 系統判不了的情形）；off 時回到 'auto' 讓規則重新判定，不是留在某個
   * 人工覆寫值上。 */
  async function toggleStampDutyNotRequired(c: Contract, notRequired: boolean) {
    setError(null);
    try {
      await updateContract(c.id, { stampDutyRequired: notRequired ? "no" : "auto" });
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  async function editStampDutyNote(c: Contract) {
    const note = window.prompt("印花稅備註（例如：各自貼一份／已取得免稅憑證）", c.stampDutyNote ?? "");
    if (note === null) return;
    setError(null);
    try {
      await updateContract(c.id, { stampDutyNote: note.trim() || null });
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  async function removeContract(c: Contract) {
    const reason = window.prompt(`作廢「${c.title}」的理由？`);
    if (!reason?.trim()) return;
    setError(null);
    try {
      await deleteContract(c.id, reason.trim());
      await load();
    } catch (err) {
      setError(humanError(err, "作廢失敗"));
    }
  }

  function pickContractScan(contractId: string) {
    pendingContractId.current = contractId;
    contractFileRef.current?.click();
  }

  async function onUploadContractScan(file: File | undefined) {
    const contractId = pendingContractId.current;
    pendingContractId.current = null;
    if (contractFileRef.current) contractFileRef.current.value = "";
    if (!file || !contractId) return;
    setError(null);
    try {
      await uploadProjectDocument(projectId, file, contractId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700">合約與報價單</h2>
        {project.hasSignedContract ? (
          <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">已簽約</span>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">尚未簽約</span>
        )}
      </div>

      {contracts.length === 0 ? (
        <Empty>尚無文件</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-3">類型</th>
                <th className="py-2 pr-3">名稱</th>
                <th className="py-2 pr-3">對方</th>
                <th className="py-2 pr-3 text-right">金額</th>
                <th className="py-2 pr-3">簽訂日</th>
                <th className="py-2 pr-3 text-right">印花稅</th>
                <th className="py-2 pr-3">貼花方式／狀態</th>
                <th className="py-2 pr-3">掃描檔</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-2 pr-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${c.docType === "contract" ? "bg-blue-50 text-blue-700" : c.docType === "change_order" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600"}`}>
                      {DOC_TYPE_LABELS[c.docType]}
                    </span>
                    {c.version > 1 && <span className="ml-1 text-xs text-gray-400">v{c.version}</span>}
                  </td>
                  <td className="py-2 pr-3 font-medium text-gray-900">{c.title}</td>
                  <td className="py-2 pr-3 text-gray-600">{c.counterparty ?? "—"}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{fmtMoney(c.amount)}</td>
                  <td className="py-2 pr-3 text-gray-600">{c.signedOn ?? "—"}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">
                    {!c.dutiable ? (
                      <span className="text-xs text-gray-400">不課</span>
                    ) : c.stampDutyAmount == null ? (
                      <span className="text-xs text-red-600" title="應貼花但沒有金額，算不出稅額">
                        缺金額
                      </span>
                    ) : (
                      fmtMoney(c.stampDutyAmount)
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-col items-start gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          className="rounded border border-gray-200 px-1 py-0.5 text-xs text-gray-600"
                          value={c.ourRole}
                          onChange={(e) => changeOurRole(c, e.target.value as OurRole)}
                          title="貼花方式：我方貼／對方貼／各自貼"
                        >
                          {(Object.keys(OUR_ROLE_SHORT_LABELS) as OurRole[]).map((v) => (
                            <option key={v} value={v}>
                              {OUR_ROLE_SHORT_LABELS[v]}
                            </option>
                          ))}
                        </select>
                        <label className="flex items-center gap-1 text-xs text-gray-500">
                          <input
                            type="checkbox"
                            checked={c.stampDutyRequired === "no"}
                            onChange={(e) => toggleStampDutyNotRequired(c, e.target.checked)}
                          />
                          不用貼
                        </label>
                      </div>
                      {!c.dutiable ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : c.stampDutyPaidOn ? (
                        <button
                          type="button"
                          className="text-xs text-green-700 hover:underline"
                          onClick={() => markStamped(c, null)}
                          title="點一下取消標記"
                        >
                          已貼 {c.stampDutyPaidOn}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                          onClick={() => markStamped(c, new Date().toISOString().slice(0, 10))}
                        >
                          標記已貼花
                        </button>
                      )}
                      <button
                        type="button"
                        className="max-w-[9rem] truncate text-left text-xs text-gray-400 hover:text-gray-600"
                        onClick={() => editStampDutyNote(c)}
                        title={c.stampDutyNote ?? "新增印花稅備註"}
                      >
                        {c.stampDutyNote ? `備註：${c.stampDutyNote}` : "＋ 備註"}
                      </button>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {(scansByContract.get(c.id) ?? []).map((doc) => (
                        <span key={doc.id} className="inline-flex items-center gap-1">
                          <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="text-xs" style={{ color: "var(--brand)" }} title={`${Math.round(doc.sizeBytes / 1024)} KB`}>
                            {doc.fileName}
                          </a>
                          <button type="button" className="text-xs text-gray-300 hover:text-red-600" onClick={() => removeDoc(doc)} title="刪除掃描檔">
                            ×
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                        onClick={() => pickContractScan(c.id)}
                      >
                        上傳掃描檔
                      </button>
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      type="button"
                      className="text-xs text-gray-400 hover:text-red-600"
                      onClick={() => removeContract(c)}
                    >
                      作廢
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <input
        ref={contractFileRef}
        type="file"
        className="hidden"
        onChange={(e) => onUploadContractScan(e.target.files?.[0])}
      />

      <div className="mt-4 border-t pt-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>類型</label>
            <select className={inputCls} value={cDocType} onChange={(e) => setCDocType(e.target.value as DocType)}>
              {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((v) => (
                <option key={v} value={v}>{DOC_TYPE_LABELS[v]}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">報價單不是契據，不課印花稅。</p>
          </div>
          <div>
            <label className={labelCls}>我方角色</label>
            <select className={inputCls} value={cOurRole} onChange={(e) => setCOurRole(e.target.value as OurRole)}>
              {(Object.keys(OUR_ROLE_LABELS) as OurRole[]).map((v) => (
                <option key={v} value={v}>{OUR_ROLE_LABELS[v]}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">承攬契據由承攬人貼花，發包出去的由下包貼；各自貼＝雙方各執一份、各自負責己方，我方仍需貼。</p>
          </div>
          <div>
            <label className={labelCls}>文件名稱 *</label>
            <input className={inputCls} value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder="例如：官網改版承攬契約" />
          </div>
          <div>
            <label className={labelCls}>對方（業主／下包）</label>
            <input className={inputCls} value={cCounterparty} onChange={(e) => setCCounterparty(e.target.value)} placeholder="選填" />
          </div>
          <div>
            <label className={labelCls}>金額</label>
            <input className={inputCls} type="number" value={cAmount} onChange={(e) => setCAmount(e.target.value)} placeholder="追加減帳可填負數" />
          </div>
          <div>
            <label className={labelCls}>簽訂日</label>
            <input className={inputCls} type="date" value={cSignedOn} onChange={(e) => setCSignedOn(e.target.value)} />
            <p className="mt-1 text-xs text-gray-400">沒有簽訂日就不算已簽約，也不會進印花稅清單。</p>
          </div>
          <div>
            <label className={labelCls}>份數</label>
            <input className={inputCls} type="number" min="1" value={cCopies} onChange={(e) => setCCopies(e.target.value)} />
            <p className="mt-1 text-xs text-gray-400">同一憑證繕寫兩份以上，各份均應貼用。</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <PrimaryButton onClick={addContract} disabled={savingContract}>
            {savingContract ? "新增中…" : "新增文件"}
          </PrimaryButton>
          <span className="text-xs text-gray-400">
            印花稅為系統試算，非申報值；承攬契據認定與免稅憑證請會計師確認。
          </span>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
