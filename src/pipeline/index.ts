import { Hono } from "hono";
import type { Bindings, QueueMessage } from "../shared/env";
import { listReadyJobs } from "../infrastructure/db";
import { runDiscovery, processJob, handleQueueBatch, runScheduled } from "./run";

type PipelineEnv = { Bindings: Bindings };

const app = new Hono<PipelineEnv>();

app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({
      ok: true,
      service: "understory-pipeline",
      environment: c.env.ENVIRONMENT,
      ai: Boolean(c.env.AI),
      time: new Date().toISOString(),
    });
  } catch {
    return c.json({ ok: false, service: "understory-pipeline", error: "database_unreachable" }, 503);
  }
});

app.post("/run/discovery", async (c) => {
  if (!(await authorized(c.req.header("authorization"), c.env.ADMIN_TOKEN))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  try {
    const result = await runDiscovery(c.env, "manual");
    return c.json(result);
  } catch (error) {
    return c.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

app.post("/run/jobs", async (c) => {
  if (!(await authorized(c.req.header("authorization"), c.env.ADMIN_TOKEN))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const requested = Number.parseInt(c.req.query("limit") ?? "3", 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(10, requested)) : 3;
  const jobs = await listReadyJobs(c.env.DB, limit);
  const results = [];
  for (const job of jobs) {
    results.push({ jobId: job.id, kind: job.kind, ...(await processJob(c.env, job.id)) });
  }
  return c.json({ ok: true, processed: results.length, results });
});

app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));

app.onError((error, c) => {
  console.error(
    JSON.stringify({
      level: "error",
      service: "understory-pipeline",
      path: c.req.path,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  return c.json({ ok: false, error: "internal_error" }, 500);
});

async function authorized(header: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  if (!header?.toLowerCase().startsWith("bearer ")) return false;
  const supplied = header.slice(7).trim();
  if (!supplied) return false;

  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

export default {
  fetch(request: Request, env: Bindings, executionCtx: ExecutionContext) {
    return app.fetch(request, env, executionCtx);
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Bindings) {
    await handleQueueBatch(env, [...batch.messages]);
  },
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime)));
  },
};
