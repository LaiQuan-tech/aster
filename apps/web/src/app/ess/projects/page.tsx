"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, InlineError, Pill, type PillTone } from "@/components/ess-ui";
import { listProjects, statusLabel, type Project } from "@/lib/projects-api";

const STATUS_TONE: Record<string, PillTone> = {
  active: "green",
  suspended: "amber",
  closed: "gray",
  terminated: "red",
};

export default function EssProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then((r) => setProjects(r.projects))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-4 text-sm text-gray-500">瀏覽公司所有專案的資料與文件。你的分潤只有你自己（與主管）看得到。</p>
        {error && <InlineError className="mb-3">{error}</InlineError>}
        {projects.length === 0 ? (
          <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-400">尚無專案</p>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/ess/projects/${p.id}`}
                  className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 p-4 hover:bg-gray-100"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">
                      {p.name}
                      {p.code && <span className="ml-2 font-mono text-xs text-gray-400">{p.code}</span>}
                    </p>
                    {p.description && <p className="mt-0.5 truncate text-sm text-gray-500">{p.description}</p>}
                  </div>
                  <Pill tone={STATUS_TONE[p.status] ?? "gray"} className="ml-3 shrink-0">
                    {statusLabel(p.status)}
                  </Pill>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
