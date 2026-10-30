import type { Job } from "../domain/article";
import type { SourceBlock, SourceSnapshot } from "../domain/source";
import {
  articleIdFromUrl,
  canonicalizeUrl,
  hostOf,
  sha256Hex,
  slugify,
} from "../domain/source";
import { sourceSnapshotSchema } from "../domain/source";
import {
  duplicateWindowStart,
  findDuplicate,
  formatSelectionReason,
  scoreSource,
  SELECTION_DUPLICATE_WINDOW_DAYS,
} from "../domain/selection";
import {
  claimJob,
  completeJob,
  createJob,
  deferJob,
  failJob,
  findArticleBySlug,
  findArticlesByUrls,
  findRevisionKey,
  findSourceByHost,
  getArticleRow,
  getMeta,
  getSnapshotById,
  insertArticle,
  insertRevision,
  listReadyJobs,
  listRecentSourceArticles,
  recordBudgetUsage,
  releaseBudgetReservation,
  reserveBudget,
  renewJobLease,
  requeueDuplicates,
  saveSnapshot,
  setArticleStatus,
  setMeta,
  upsertSource,
} from "../infrastructure/db";
import { bool, dailyNeuronBudget, type Bindings, type QueueMessage } from "../shared/env";
import { fetchPublicText } from "../shared/fetch";
import { parseDiscoveryHtml } from "./discovery";
import { extractArticle, fetchArticlePage, toSnapshot } from "./extract";
import { attemptGeneration, neuronsFromUsage } from "./generate";
import { PROMPT_VERSION, SCHEMA_VERSION, type GenerationMaterial } from "./prompt";

const ESTIMATED_NEURONS_PER_ATTEMPT = 500;
const MAX_NEW_ARTICLES_PER_DISCOVERY = 6;
const MAX_AGE_DAYS = 4;
const MIN_SOURCE_WORDS = 220;
const DISCOVERY_INTERVAL_MINUTES = 30;

export type RunResult = {
  ok: boolean;
  detail: string;
  counts?: Record<string, number>;
  deferred?: boolean;
};

export async function runDiscovery(env: Bindings, reason: string): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const discoveryUrl = env.DISCOVERY_URL ?? "https://engineeringblogs.xyz/";

  const { text: html } = await fetchPublicText(discoveryUrl, {
    maxBytes: 700_000,
    timeoutMs: 20_000,
    headers: {
      "User-Agent": `UnderstoryBot/0.1 (+${env.SITE_URL}/about)`,
      Accept: "text/html",
    },
  });
  const now = Date.now();
  const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const posts = parseDiscoveryHtml(html)
    .filter((post) => {
      const published = Date.parse(post.publishedAt);
      return Number.isFinite(published) && published >= cutoff;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  let inserted = 0;
  let skipped = 0;
  let queued = 0;

  const known = await findArticlesByUrls(env.DB, posts.map((post) => post.url));

  for (const post of posts) {
    if (inserted >= MAX_NEW_ARTICLES_PER_DISCOVERY) break;

    const existing = known.get(post.url);
    if (existing) {
      if (existing.status === "discovered") {
        await createJob(env.DB, { id: `job_extract_${existing.id}`, kind: "extract", articleId: existing.id,
          idempotencyKey: `extract:${existing.id}`, payload: { reason } });
      }
      skipped += 1;
      continue;
    }

    let host: string;
    try {
      host = hostOf(post.sourceSiteUrl);
    } catch {
      continue;
    }

    let source = await findSourceByHost(env.DB, host);
    if (!source) {
      const sourceId = `src_${slugify(host, 48)}`;
      await upsertSource(env.DB, {
        id: sourceId,
        name: post.sourceName.slice(0, 160),
        siteUrl: post.sourceSiteUrl,
        host,
      });
      source = {
        id: sourceId,
        name: post.sourceName,
        siteUrl: post.sourceSiteUrl,
        feedUrl: null,
        host,
        status: "active",
      };
    }

    const articleId = await articleIdFromUrl(post.url);
    const slug = await uniqueSlug(env, post.title, post.url);
    const wasInserted = await insertArticle(env.DB, {
      id: articleId,
      sourceId: source.id,
      canonicalUrl: post.url,
      originalTitle: post.title,
      publishedAt: post.publishedAt,
      discoveredAt: startedAt,
      slug,
    });
    if (!wasInserted) {
      skipped += 1;
      continue;
    }

    inserted += 1;
    const jobId = `job_extract_${articleId}`;

    try {
      await env.PIPELINE_QUEUE.send({ kind: "job", jobId });
      queued += 1;
    } catch {
      // The scheduled sweep will pick up ready jobs if the queue is unavailable.
    }
  }

  await setMeta(env.DB, "last_discovery_at", startedAt);
  await setMeta(env.DB, "last_discovery_result", `${inserted} new / ${skipped} known`);

  return {
    ok: true,
    detail: `Discovery finished: ${inserted} new, ${skipped} known, ${queued} queued.`,
    counts: { found: posts.length, inserted, skipped, queued },
  };
}

async function uniqueSlug(env: Bindings, title: string, url: string): Promise<string> {
  const base = slugify(title, 64);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!(await findArticleBySlug(env.DB, candidate))) return candidate;
  }
  const hash = await sha256Hex(url);
  return `${base}-${hash.slice(0, 6)}`;
}

export async function runExtractJob(env: Bindings, job: Job): Promise<RunResult> {
  if (!job.articleId) return { ok: false, detail: "Extract job has no article." };
  const article = await getArticleRow(env.DB, job.articleId);
  if (!article) return { ok: false, detail: "Article no longer exists." };
  if (article.status === "published" || article.status === "review") {
    return { ok: true, detail: "Article is already past extraction." };
  }

  await setArticleStatus(env.DB, article.id, "extracting", null, job);
  try {
    const fetched = await fetchArticlePage(
      article.canonicalUrl,
      `UnderstoryBot/0.1 (+${env.SITE_URL}/about)`,
    );
    const extracted = await extractArticle(fetched.html, fetched.finalUrl);
    if (extracted.wordCount < MIN_SOURCE_WORDS) {
      const reason = `Source page yielded ${extracted.wordCount} words, below the ${MIN_SOURCE_WORDS}-word floor.`;
      const skipped = await setArticleStatus(
        env.DB,
        article.id,
        "skipped",
        reason,
        job,
        { score: 0, reason, duplicateOf: null },
      );
      if (skipped) await requeueDuplicates(env.DB, article.id);
      return { ok: true, detail: `Skipped thin source (${extracted.wordCount} words).` };
    }

    const snapshot = toSnapshot(article.id, fetched.finalUrl, new Date().toISOString(), extracted);
    const parsed = sourceSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new Error(`Snapshot failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }

    const blocksJson = JSON.stringify(parsed.data.blocks);
    const sourceHash = await sha256Hex(`${fetched.finalUrl}\n${blocksJson}`);
    let snapshotId = `snap_${sourceHash.slice(0, 24)}`;
    const existing = await env.DB.prepare(
      "SELECT id FROM article_snapshots WHERE article_id = ? AND source_hash = ?",
    )
      .bind(article.id, sourceHash)
      .first<{ id: string }>();
    if (existing) snapshotId = existing.id;
    else {
      await saveSnapshot(env.DB, {
        id: snapshotId,
        articleId: article.id,
        sourceHash,
        blocksJson,
        wordCount: parsed.data.wordCount,
        extractorVersion: parsed.data.extractorVersion,
        fetchedAt: parsed.data.fetchedAt,
        finalUrl: fetched.finalUrl,
        httpStatus: fetched.status,
      }, job);
    }

    const selection = scoreSource({
      title: article.originalTitle,
      url: article.canonicalUrl,
      blocks: parsed.data.blocks,
      wordCount: parsed.data.wordCount,
    });
    const recent = await listRecentSourceArticles(
      env.DB,
      article.sourceId,
      article.id,
      duplicateWindowStart(article.publishedAt, SELECTION_DUPLICATE_WINDOW_DAYS),
    );
    const duplicate = findDuplicate(article.originalTitle, recent);
    const reason = duplicate
      ? `duplicate of ${duplicate.slug}`
      : formatSelectionReason(selection.reasons) || null;
    const skipped = bool(env.SELECTION_ENFORCE) && (duplicate !== null || selection.decision === "skip");
    const updated = await setArticleStatus(
      env.DB,
      article.id,
      skipped ? "skipped" : "generating",
      skipped ? reason : null,
      job,
      { score: selection.score, reason, duplicateOf: duplicate?.id ?? null },
    );
    if (!updated) return { ok: true, detail: "Discarded stale extraction result." };
    if (skipped) {
      await requeueDuplicates(env.DB, article.id);
      return { ok: true, detail: `Skipped by selection gate: ${reason ?? "low score"}` };
    }
    const jobId = `job_${crypto.randomUUID()}`;
    await createJob(env.DB, {
      id: jobId,
      kind: "generate",
      articleId: article.id,
      idempotencyKey: `generate:${snapshotId}`,
      payload: {
        snapshotId,
        links: extracted.links,
        finalUrl: fetched.finalUrl,
      },
    }, job);

    try {
      const ready = await env.DB.prepare(`SELECT id FROM jobs WHERE id = ? AND state = 'pending'
        AND EXISTS (SELECT 1 FROM jobs lease WHERE lease.id = ? AND lease.lease_token = ?
          AND lease.article_id = ? AND lease.state = 'running'
          AND lease.lease_expires_at > MAX(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`)
        .bind(jobId, job.id, job.leaseToken, article.id, new Date().toISOString()).first();
      if (ready) await env.PIPELINE_QUEUE.send({ kind: "job", jobId });
    } catch {
      // Ready-job sweep will retry.
    }

    return {
      ok: true,
      detail: `Extracted ${parsed.data.wordCount} words into ${parsed.data.blocks.length} blocks.`,
      counts: { words: parsed.data.wordCount, blocks: parsed.data.blocks.length },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await setArticleStatus(env.DB, article.id, "failed", message.slice(0, 500), job);
    if (failed && job.attempts >= 3) await requeueDuplicates(env.DB, article.id);
    throw error;
  }
}

export async function runGenerateJob(env: Bindings, job: Job): Promise<RunResult> {
  if (!env.AI) return { ok: false, detail: "Workers AI binding is not configured." };
  if (!job.articleId) return { ok: false, detail: "Generate job has no article." };

  const article = await getArticleRow(env.DB, job.articleId);
  if (!article) return { ok: false, detail: "Article no longer exists." };
  if (article.status === "published") return { ok: true, detail: "Article is already published." };

  const payload = parsePayload(job.payloadJson);
  const snapshotId = typeof payload.snapshotId === "string" ? payload.snapshotId : null;
  if (!snapshotId) return { ok: false, detail: "Generate job has no snapshot id." };

  const snapshot = await getSnapshotById(env.DB, snapshotId);
  if (!snapshot || snapshot.articleId !== article.id) return { ok: false, detail: "Snapshot no longer exists for this article." };

  const model = env.AI_MODEL ?? "@cf/qwen/qwen3-30b-a3b-fp8";
  const existingRevision = await findRevisionKey(env.DB, {
    articleId: article.id,
    snapshotId,
    modelId: model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  });
  if (existingRevision) {
    if (existingRevision.status === "draft") await setArticleStatus(env.DB, article.id, "review", null, job);
    else if (existingRevision.status === "rejected") await setArticleStatus(env.DB, article.id, "failed", "Revision was rejected; generation key is already consumed.", job);
    return { ok: true, detail: `Revision already exists for this snapshot (${existingRevision.status}).` };
  }

  const links = Array.isArray(payload.links)
    ? payload.links
        .filter(
          (link): link is { url: string; host: string } =>
            Boolean(link) &&
            typeof link === "object" &&
            typeof (link as { url?: unknown }).url === "string" &&
            typeof (link as { host?: unknown }).host === "string",
        )
        .slice(0, 30)
    : [];

  const material: GenerationMaterial = {
    articleTitle: article.originalTitle,
    articleUrl: article.canonicalUrl,
    articlePublishedAt: article.publishedAt,
    sourceName:
      (
        await env.DB.prepare("SELECT name FROM sources WHERE id = ?")
          .bind(article.sourceId)
          .first<{ name: string }>()
      )?.name ?? "Engineering blog",
    snapshot: {
      articleId: article.id,
      title: article.originalTitle,
      url: article.canonicalUrl,
      fetchedAt: new Date().toISOString(),
      extractorVersion: "htmlrewriter-1",
      blocks: parseBlocks(snapshot.blocksJson),
      wordCount: snapshot.wordCount,
    },
    links,
  };

  const dailyBudget = dailyNeuronBudget(env.DAILY_NEURON_BUDGET);
  const day = new Date().toISOString().slice(0, 10);
  let attempt = 1;
  let previous: { rawText: string; issues: Array<{ path: string; message: string }> } | null = null;
  let generation = null as Awaited<ReturnType<typeof attemptGeneration>> | null;

  while (attempt <= 2) {
    if (!await renewJobLease(env.DB, job)) return { ok: false, detail: "Job lease lost." };
    const reserved = await reserveBudget(env.DB, day, ESTIMATED_NEURONS_PER_ATTEMPT, dailyBudget);
    if (!reserved) {
      await deferJob(
        env.DB,
        { id: job.id, leaseToken: job.leaseToken },
        nextUtcMidnight(),
        "Daily model budget is fully reserved.",
      );
      return { ok: true, detail: "Deferred until the next UTC day: budget exhausted.", deferred: true };
    }

    try {
      generation = await attemptGeneration(env.AI, model, material, previous);
    } catch (error) {
      // A transport or binding failure should not consume the day's budget.
      await releaseBudgetReservation(env.DB, day, ESTIMATED_NEURONS_PER_ATTEMPT);
      throw error;
    }
    await recordBudgetUsage(env.DB, day, ESTIMATED_NEURONS_PER_ATTEMPT, neuronsFromUsage(generation.usage, model));

    if (generation.ok) break;
    previous = { rawText: generation.rawText, issues: generation.issues };
    attempt += 1;
  }

  if (!generation || !generation.ok || !generation.explanation) {
    const issues = generation?.issues ?? [{ path: "(root)", message: "No generation result" }];
    const message = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ").slice(0, 700);
    if (await setArticleStatus(env.DB, article.id, "failed", message, job)) {
      await requeueDuplicates(env.DB, article.id);
    }
    // A schema or editorial rejection is deterministic; retrying the job only
    // repeats the same model call and burns the daily neuron budget.
    await failJob(env.DB, job, message, { terminal: true });
    return { ok: false, detail: `Generation rejected: ${message}` };
  }

  const generatedAt = new Date().toISOString();
  const autoPublish = bool(env.AUTO_PUBLISH);
  const reviewer = "Understory automated validation";
  const provenance = {
    origin: "workers-ai",
    modelId: model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    attempts: attempt,
    sourceSnapshotId: snapshotId,
    sourceHash: null,
    usage: generation.usage,
    materialLinks: links.map((link) => link.url),
    ...(autoPublish ? { reviewedBy: reviewer } : {}),
    editorial: autoPublish
      ? "Automatically published after schema, citation, diagram, and source checks; not human-reviewed."
      : "Draft only. Publication requires a human review.",
  };

  const inserted = await insertRevision(env.DB, {
    id: `rev_${crypto.randomUUID()}`,
    articleId: article.id,
    snapshotId,
    contentJson: JSON.stringify(generation.explanation),
    provenanceJson: JSON.stringify(provenance),
    modelId: model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
  }, job, autoPublish ? { reviewer } : undefined);

  if (inserted && !autoPublish) await setArticleStatus(env.DB, article.id, "review", null, job);
  else if (!inserted) {
    const revision = await findRevisionKey(env.DB, { articleId: article.id, snapshotId, modelId: model, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION });
    if (revision?.status === "draft") await setArticleStatus(env.DB, article.id, "review", null, job);
  }
  return {
    ok: true,
    detail: inserted
      ? `${autoPublish ? "Automatically published" : "Draft ready for review"}: ${generation.explanation.contextHeadline}`
      : "Draft already existed; marked job complete.",
    counts: { attempts: attempt },
  };
}

export async function processJob(env: Bindings, jobId: string, leaseSeconds = 120): Promise<RunResult> {
  const leaseToken = crypto.randomUUID();
  const job = await claimJob(env.DB, jobId, leaseToken, leaseSeconds);
  if (!job) return { ok: true, detail: "Job is not claimable (leased, complete, or not due)." };

  let renewal = Promise.resolve();
  const heartbeat = setInterval(() => {
    renewal = renewal.then(async () => {
      // A failed renewal must never revive an expired/replaced lease; writes remain fenced.
      if (!await renewJobLease(env.DB, job, leaseSeconds)) clearInterval(heartbeat);
    }).catch(() => { clearInterval(heartbeat); });
  }, Math.min(30_000, leaseSeconds * 1000 / 3));

  try {
    let result: RunResult;
    if (job.kind === "extract" && job.articleId) result = await runExtractJob(env, job);
    else if (job.kind === "generate") result = await runGenerateJob(env, job);
    else if (job.kind === "discover") result = await runDiscovery(env, "job");
    else result = { ok: false, detail: `Unknown or malformed job kind: ${job.kind}` };

    if (result.ok && !result.deferred) await completeJob(env.DB, job.id, leaseToken);
    else if (!result.ok) await failJob(env.DB, job, result.detail, { terminal: job.attempts >= 3 });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (job.kind === "generate" && job.articleId && job.attempts >= 3
      && await setArticleStatus(env.DB, job.articleId, "failed", message, job)) {
      await requeueDuplicates(env.DB, job.articleId);
    }
    await failJob(env.DB, job, message, { terminal: job.attempts >= 3 });
    return { ok: false, detail: message };
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
}

export async function handleQueueBatch(
  env: Bindings,
  messages: Message<QueueMessage>[],
): Promise<void> {
  for (const message of messages) {
    try {
      if (message.body.kind === "discover") await runDiscovery(env, message.body.reason ?? "queue");
      else if (message.body.kind === "job") await processJob(env, message.body.jobId);
      message.ack();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ level: "error", service: "understory-pipeline", message: messageText }));
      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function runScheduled(env: Bindings, now = new Date()): Promise<void> {
  const last = await getMeta(env.DB, "last_discovery_enqueued_at");
  const lastMs = last ? Date.parse(last) : 0;
  const due = !Number.isFinite(lastMs) || now.getTime() - lastMs >= DISCOVERY_INTERVAL_MINUTES * 60_000;

  if (due) {
    await env.PIPELINE_QUEUE.send({ kind: "discover", reason: "cron" });
    await setMeta(env.DB, "last_discovery_enqueued_at", now.toISOString());
  }

  // Queue messages make each heavy step its own invocation. Duplicate messages
  // are harmless because claimJob is atomic.
  const ready = await listReadyJobs(env.DB, 3);
  for (const job of ready) {
    try {
      await env.PIPELINE_QUEUE.send({ kind: "job", jobId: job.id });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "understory-pipeline",
          jobId: job.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseBlocks(raw: string): SourceBlock[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as SourceBlock[]) : [];
  } catch {
    return [];
  }
}

function nextUtcMidnight(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 2, 0),
  ).toISOString();
}
