"use client";

import { useEffect, useState } from "react";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import {
  getBranding,
  getMe,
  isAdminRole,
  getInternalJobs,
  type Branding,
  type InternalJob,
} from "@/lib/ess-api";

function JobsInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [jobs, setJobs] = useState<InternalJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
    getInternalJobs()
      .then((r) => setJobs(r.internalJobs))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  return (
    <div className="min-h-dvh bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="jobs" isAdmin={isAdmin} />
      <main className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-800">內部職缺</h2>
          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          <ul className="divide-y divide-gray-100">
            {jobs.map((j) => (
              <li key={j.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-800">{j.title}</span>
                  <span className="text-xs text-gray-500">需 {j.headcount} 人</span>
                </div>
                {j.description && <p className="mt-1 text-sm text-gray-600">{j.description}</p>}
                <p className="mt-1 text-xs text-gray-400">有興趣請洽人資</p>
              </li>
            ))}
            {jobs.length === 0 && <li className="py-3 text-sm text-gray-400">目前無開放中的內部職缺</li>}
          </ul>
        </section>
      </main>
    </div>
  );
}

export default function JobsPage() {
  return (
    <EssTabGate tab="jobs">
      <JobsInner />
    </EssTabGate>
  );
}
