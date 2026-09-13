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
];

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
      };
      const endpoint = endpointByJob[job.name] ?? "/internal/attendance/daily-settle";
      const body =
        job.name === "deliver-pending-notifications"
          ? { limit: typeof job.data?.limit === "number" ? job.data.limit : 50 }
          : job.name === "detect-and-notify-attendance"
            ? {
                ...(typeof job.data?.date === "string" ? { date: job.data.date } : {}),
                anomalyDays: typeof job.data?.anomalyDays === "number" ? job.data.anomalyDays : 7,
              }
            : typeof job.data?.date === "string"
              ? { date: job.data.date }
              : {};
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
      if (!response.ok) {
        throw new Error(`${job.name} API failed ${response.status}: ${text.slice(0, 500)}`);
      }
      logger.info({ jobId: job.id, name: job.name, result: payload }, `${job.name} completed`);
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
  logger.info("Worker process started (attendance + detection + notifications)");
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
