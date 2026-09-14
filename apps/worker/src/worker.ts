import http from "http";
import "dotenv/config";
import pino from "pino";
import { Worker } from "bullmq";
// NB: explicit .js extension — this is an ESM package ("type":"module") and the
// `start` script runs the compiled output under Node ESM, which requires
// extensions on relative imports. TS (moduleResolution: bundler) accepts it.
import { attendanceQueue, maybeRedis } from "./lib/queue.js";

const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

// Holds the BullMQ Worker so graceful shutdown can close it. Null when no
// Redis is configured (skeleton-only mode).
let attendanceWorker: Worker | null = null;

const SCHEDULER_IDS = [
  "daily-attendance-settle",
  "deliver-pending-notifications",
  "detect-and-notify-attendance",
  "auto-archive-projects",
  "project-alerts",
  "generate-attendance-sheets",
  "monthly-snapshot",
];

/** 月度快照是「一次呼叫做一段、帶游標續打」的分頁 API；這是續打次數上限（防迴圈跑不完）。 */
const MONTHLY_SNAPSHOT_MAX_CALLS = 300;

async function postInternal(
  baseUrl: string,
  token: string,
  endpoint: string,
  body: unknown,
): Promise<{ status: number; ok: boolean; text: string; payload: unknown }> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-job-token": token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    /* keep text payload */
  }
  return { status: response.status, ok: response.ok, text, payload };
}

/**
 * Register the daily attendance settlement scheduler.
 *
 * Only called when REDIS_URL is present (and therefore attendanceQueue exists).
 * Registers a cron via upsertJobScheduler — idempotent, so re-deploys don't
 * pile up duplicate schedulers — and calls the API's protected internal settle
 * endpoint. The API owns tenant-scoped DB access and the @hr/rules settlement
 * implementation plus detection services; the worker is just the clock.
 */
async function registerSchedulers() {
  if (!attendanceQueue || !maybeRedis) return;

  if (process.env.ENABLE_WORKER_SCHEDULERS !== "true") {
    const queue = attendanceQueue;
    await Promise.allSettled(SCHEDULER_IDS.map((id) => queue.removeJobScheduler(id)));
    logger.warn("ENABLE_WORKER_SCHEDULERS is not true — job schedulers are paused");
    return;
  }

  await attendanceQueue.upsertJobScheduler(
    "daily-attendance-settle",
    { pattern: "0 2 * * *", tz: "Asia/Taipei" },
    { name: "daily-attendance-settle", data: {} },
  );
  await attendanceQueue.upsertJobScheduler(
    "deliver-pending-notifications",
    { pattern: "*/5 * * * *", tz: "Asia/Taipei" },
    { name: "deliver-pending-notifications", data: { limit: 50 } },
  );
  await attendanceQueue.upsertJobScheduler(
    "detect-and-notify-attendance",
    { pattern: "0 3 * * *", tz: "Asia/Taipei" },
    { name: "detect-and-notify-attendance", data: { anomalyDays: 7 } },
  );
  // 自動封存終止已久的專案（模組四第 2 條）。一天一次就夠——門檻是「月」，
  // 早幾小時晚幾小時沒有任何差別，排在出勤那幾支之後避免互相搶。
  await attendanceQueue.upsertJobScheduler(
    "auto-archive-projects",
    { pattern: "0 4 * * *", tz: "Asia/Taipei" },
    { name: "auto-archive-projects", data: {} },
  );
  // 專案進度示警：逾期請款、到期未結案等，通知 lead 與 HR。排在自動封存之後，
  // 剛被封存的案子就不會再被示警。
  await attendanceQueue.upsertJobScheduler(
    "project-alerts",
    { pattern: "30 4 * * *", tz: "Asia/Taipei" },
    { name: "project-alerts", data: {} },
  );
  // 出勤月表（P1）：每月 1 日 05:00 台北，對所有租戶產生上個月的月表草稿
  // （含結算）。排在每日結算之後，月底最後一天的打卡已入 attendance_days。
  await attendanceQueue.upsertJobScheduler(
    "generate-attendance-sheets",
    { pattern: "0 5 1 * *", tz: "Asia/Taipei" },
    { name: "generate-attendance-sheets", data: {} },
  );
  // 月度快照備份（C3）：每月 1 日 06:00 台北，所有 active 租戶的業務表全表快照
  // 上個月版本進 Storage `tenant-snapshots`。排在月表產生之後，快照裡就有上月月表。
  // API 端一次只做一段（Vercel 60 秒限制），handler 內 while(!done) 續打。
  await attendanceQueue.upsertJobScheduler(
    "monthly-snapshot",
    { pattern: "0 6 1 * *", tz: "Asia/Taipei" },
    { name: "monthly-snapshot", data: {} },
  );

  attendanceWorker = new Worker(
    "attendance",
    async (job) => {
      const apiUrl = process.env.API_INTERNAL_URL ?? process.env.API_URL;
      const token = process.env.INTERNAL_JOB_TOKEN;
      if (!apiUrl || !token) {
        logger.warn(
          { jobId: job.id, name: job.name, hasApiUrl: !!apiUrl, hasToken: !!token },
          "internal API job skipped: API_INTERNAL_URL/API_URL or INTERNAL_JOB_TOKEN missing",
        );
        return;
      }

      const baseUrl = apiUrl.replace(/\/$/, "");
      const endpointByJob: Record<string, string> = {
        "daily-attendance-settle": "/internal/attendance/daily-settle",
        "deliver-pending-notifications": "/internal/notifications/deliver-pending",
        "detect-and-notify-attendance": "/internal/attendance/detect-and-notify",
        "auto-archive-projects": "/internal/projects/auto-archive",
        "project-alerts": "/internal/projects/alert-notify",
        "generate-attendance-sheets": "/internal/attendance-sheets/generate",
        "monthly-snapshot": "/internal/backups/monthly-snapshot",
      };
      const endpoint = endpointByJob[job.name] ?? "/internal/attendance/daily-settle";

      if (job.name === "monthly-snapshot") {
        // 分頁續打：API 回 nextTenantId/nextTable/nextOffset 就原樣帶回去，直到 done。
        // 跨租戶（allTenants）由 API 端依 active 租戶 id 排序逐一往下指。
        let body: Record<string, unknown> = {
          ...(typeof job.data?.period === "string" ? { period: job.data.period } : {}),
          ...(typeof job.data?.tenantId === "string" ? { tenantId: job.data.tenantId, allTenants: false } : {}),
        };
        let calls = 0;
        let rowsWritten = 0;
        let tablesCompleted = 0;
        const tenantsDone: string[] = [];
        for (;;) {
          calls += 1;
          const r = await postInternal(baseUrl, token, endpoint, body);
          if (!r.ok) {
            throw new Error(`${job.name} API failed ${r.status} (call ${calls}): ${r.text.slice(0, 500)}`);
          }
          const p = (r.payload ?? {}) as {
            done?: boolean;
            tenantId?: string | null;
            period?: string;
            table?: string | null;
            rowsWritten?: number;
            tablesCompleted?: number;
            manifestPath?: string;
            nextTenantId?: string;
            nextTable?: string;
            nextOffset?: number;
          };
          rowsWritten += p.rowsWritten ?? 0;
          tablesCompleted += p.tablesCompleted ?? 0;
          if (p.manifestPath && p.tenantId) tenantsDone.push(p.tenantId);
          logger.debug(
            { jobId: job.id, call: calls, tenantId: p.tenantId, table: p.table, rowsWritten: p.rowsWritten, next: p.nextTable ?? p.nextTenantId ?? null },
            "monthly-snapshot step",
          );
          if (p.done) break;
          if (calls >= MONTHLY_SNAPSHOT_MAX_CALLS) {
            throw new Error(`${job.name} exceeded ${MONTHLY_SNAPSHOT_MAX_CALLS} calls without done (last tenant ${p.tenantId}, table ${p.nextTable ?? p.table})`);
          }
          body = {
            ...(p.period ? { period: p.period } : {}),
            tenantId: p.nextTenantId ?? p.tenantId,
            ...(p.nextTable ? { table: p.nextTable } : {}),
            ...(typeof p.nextOffset === "number" ? { offset: p.nextOffset } : {}),
            allTenants: typeof job.data?.tenantId === "string" ? false : true,
          };
        }
        logger.info(
          { jobId: job.id, name: job.name, calls, rowsWritten, tablesCompleted, tenants: tenantsDone },
          `${job.name} completed`,
        );
        return;
      }

      const body =
        job.name === "deliver-pending-notifications"
          ? { limit: typeof job.data?.limit === "number" ? job.data.limit : 50 }
          : job.name === "generate-attendance-sheets"
            ? (typeof job.data?.period === "string" ? { period: job.data.period } : {})
          : job.name === "detect-and-notify-attendance"
            ? {
                ...(typeof job.data?.date === "string" ? { date: job.data.date } : {}),
                anomalyDays: typeof job.data?.anomalyDays === "number" ? job.data.anomalyDays : 7,
              }
            : typeof job.data?.date === "string"
              ? { date: job.data.date }
              : {};
      const r = await postInternal(baseUrl, token, endpoint, body);
      if (!r.ok) {
        throw new Error(`${job.name} API failed ${r.status}: ${r.text.slice(0, 500)}`);
      }
      logger.info({ jobId: job.id, name: job.name, result: r.payload }, `${job.name} completed`);
    },
    { connection: maybeRedis },
  );

  attendanceWorker.on("failed", (job, err) =>
    logger.error({ queue: "attendance", jobId: job?.id, err: err.message }, "job failed"),
  );
  attendanceWorker.on("error", (err) =>
    logger.error({ queue: "attendance", err: err.message }, "worker error"),
  );

  // 從 SCHEDULER_IDS 動態列出，避免這行訊息與實際註冊的排程數量各自維護而不同步。
  logger.info(
    { schedulers: SCHEDULER_IDS },
    `Job schedulers registered (${SCHEDULER_IDS.length}): ${SCHEDULER_IDS.join(", ")}`,
  );
}

// Minimal liveness endpoint so Railway's shared /health check passes for the
// worker service (it has no HTTP API otherwise).
const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", role: "worker", timestamp: new Date().toISOString() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = Number(process.env.PORT ?? 4001);
healthServer.listen(port, () => logger.info({ port }, "worker health server listening"));

if (process.env.REDIS_URL) {
  registerSchedulers().catch((err) => {
    logger.error({ err: err.message }, "failed to register job schedulers");
    process.exit(1);
  });
  logger.info("Worker process started (attendance + detection + notifications + monthly snapshot)");
} else {
  // Skeleton mode: no broker, so we only run the health server. This keeps the
  // worker bootable on a bare laptop without Redis.
  logger.warn("REDIS_URL not set — running health server only, schedulers disabled");
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down worker");
  healthServer.close();
  await Promise.allSettled([
    attendanceWorker?.close(),
    maybeRedis?.quit(),
  ]);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
