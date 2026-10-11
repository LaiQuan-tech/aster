"use client";

import type { RefObject } from "react";
import { Card, Empty } from "@/components/admin-ui";
import { uploadProjectDocument, type ProjectDocument } from "@/lib/projects-api";
import type { Setter } from "./shared";

interface DocumentsCardProps {
  projectId: string;
  fileRef: RefObject<HTMLInputElement | null>;
  /** 只列專案層級的文件；有效合約的掃描檔跟著合約列顯示（見 ContractsCard）。 */
  projectLevelDocs: ProjectDocument[];
  /** 看得到合約掃描檔的人（HR／該案 lead／經理與主辦成員）才會在這裡看到「作廢合約的掃描檔」。 */
  canSeeContractDocs: boolean;
  removeDoc: (doc: ProjectDocument) => Promise<void>;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/**
 * 專案文件（知識庫，全公司可下載）：上傳／列表／刪除。
 * 一般專案文件不限檔案類型（docx／xlsx／dwg／zip 都收，單檔 10 MB 以內），但不收執行檔與腳本
 * （exe／bat／sh／js／apk…，2026-10-11；選到會直接顯示說明，後端也會擋）；合約掃描檔不在這裡上傳，
 * 也不受全公司可下載的規則：只有該案經理、承辦與 HR 看得到（在「合約與報價單」各列上傳，只收 PDF 與圖片）。
 */
export function DocumentsCard({ projectId, fileRef, projectLevelDocs, canSeeContractDocs, removeDoc, setError, load }: DocumentsCardProps) {
  async function onUpload(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      await uploadProjectDocument(projectId, file);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    }
  }

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-gray-700">專案文件（全公司可下載）</h2>
      <p className="mb-3 text-xs text-gray-400">
        這裡的一般專案文件全公司都能下載（單檔 10 MB 以內，不收執行檔與腳本，例如 .exe、.bat、.sh、.js）。<strong className="font-medium text-gray-500">合約掃描檔不在此列</strong>
        ——只有該案經理、承辦與 HR 看得到，請到上方「合約與報價單」各列上傳。
      </p>
      <input
        ref={fileRef}
        type="file"
        className="mb-3 block text-sm"
        onChange={(e) => onUpload(e.target.files?.[0])}
      />
      {projectLevelDocs.length === 0 ? (
        <Empty>尚無文件</Empty>
      ) : (
        <ul className="divide-y">
          {projectLevelDocs.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between py-2 text-sm">
              <div className="min-w-0">
                <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium" style={{ color: "var(--brand)" }}>
                  {doc.fileName}
                </a>
                <span className="ml-2 text-xs text-gray-400">{Math.round(doc.sizeBytes / 1024)} KB</span>
                {canSeeContractDocs && doc.contractId && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">作廢合約的掃描檔（僅經理、承辦與 HR 可見）</span>}
              </div>
              <button onClick={() => removeDoc(doc)} className="text-xs text-red-600 hover:underline">刪除</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
