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
  removeDoc: (doc: ProjectDocument) => Promise<void>;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/** 專案文件（知識庫，全公司可下載）：上傳／列表／刪除。 */
export function DocumentsCard({ projectId, fileRef, projectLevelDocs, removeDoc, setError, load }: DocumentsCardProps) {
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
      <h2 className="mb-3 text-sm font-semibold text-gray-700">專案文件（全公司可下載）</h2>
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
                {doc.contractId && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">作廢合約的掃描檔</span>}
              </div>
              <button onClick={() => removeDoc(doc)} className="text-xs text-red-600 hover:underline">刪除</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
