"use client";

import { useEffect, useState } from "react";
import { Card, InlineError } from "@/components/ess-ui";
import { getInternalJobs, type InternalJob } from "@/lib/ess-api";

export default function JobsPage() {
  const [jobs, setJobs] = useState<InternalJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getInternalJobs()
      .then((r) => setJobs(r.internalJobs))
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        {error && <InlineError className="mb-3">{error}</InlineError>}
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
      </Card>
    </div>
  );
}
