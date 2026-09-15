"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import { getBranding, getMe, isAdminRole, type Branding } from "@/lib/ess-api";
import { listProjects, statusLabel, type Project } from "@/lib/projects-api";

const STATUS_BADGE: Record<string, string> = {
  active: "bg-green-50 text-green-700",
  suspended: "bg-amber-50 text-amber-700",
  closed: "bg-gray-100 text-gray-600",
  terminated: "bg-red-50 text-red-700",
};

function ProjectsInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    listProjects()
      .then((r) => setProjects(r.projects))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  return (
    <div className="min-h-dvh bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="projects" isAdmin={isAdmin} />
      <main className="mx-auto max-w-3xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-800">專案知識庫</h2>
          <p className="mb-4 text-sm text-gray-500">瀏覽公司所有專案的資料與文件。你的分潤只有你自己（與主管）看得到。</p>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
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
                    <span className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[p.status] ?? "bg-gray-100 text-gray-500"}`}>
                      {statusLabel(p.status)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default function EssProjectsPage() {
  return (
    <EssTabGate tab="projects">
      <ProjectsInner />
    </EssTabGate>
  );
}
