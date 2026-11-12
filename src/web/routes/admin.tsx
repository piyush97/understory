import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../../shared/env";
import { bool, dailyNeuronBudget } from "../../shared/env";
import { verifyAccessJwt } from "../../shared/access";
import { pingIndexNow } from "../../shared/indexnow";
import {
  approveRevision,
  getRevisionDetail,
  getPipelineStatus,
  listRecentSkippedArticles,
  listReviewQueue,
  rejectRevision,
} from "../../infrastructure/db";
import {
  createApiKey,
  listApiKeys,
  listApiOrgSummaries,
  revokeApiKey,
  type MintedApiKey,
} from "../../infrastructure/api";
import { Layout } from "../components/layout";
import { Blocks } from "../components/blocks";
import { DiagramPlate } from "../components/diagram";
import { validateExplanation } from "../../domain/explanation";
import { billingPeriodStart } from "../lib/api-auth";
import { parseExplanation, parseProvenance } from "../lib/content";
import { relativeDate } from "../lib/format";
import { IconArrowRight, IconCheck, IconMinus, IconArrowUpRight } from "../components/icons";

const COOKIE = "understory_admin";

type AuthResult =
  | { ok: true; reviewer: string }
  | { ok: false; missingToken: boolean };

async function authorize(c: Context<AppEnv>): Promise<AuthResult> {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return { ok: false, missingToken: true };

  const header = c.req.header("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : null;
  const cookie = getCookie(c, COOKIE);
  const supplied = bearer ?? cookie ?? null;
  if (!supplied || !(await safeEqual(supplied, expected))) {
    return { ok: false, missingToken: false };
  }

  if (bool(c.env.REQUIRE_ACCESS_JWT)) {
    const reviewer = await verifyAccessJwt(c.req.header("cf-access-jwt-assertion"), c.env);
    if (!reviewer) return { ok: false, missingToken: false };
    return { ok: true, reviewer };
  }

  return { ok: true, reviewer: "editorial" };
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(da);
  const right = new Uint8Array(db);
  let diff = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

type AdminNotice = { kind: "ok" | "error"; message: string };

export async function renderAdmin(
  c: Context<AppEnv>,
  options: { minted?: MintedApiKey; notice?: AdminNotice } = {},
) {
  const auth = await authorize(c);
  if (!auth.ok) return renderLogin(c, auth.missingToken);

  const now = new Date();
  const periodStart = billingPeriodStart(now);
  const [queue, skipped, pipeline, apiOrgs, apiKeys] = await Promise.all([
    listReviewQueue(c.env.DB),
    listRecentSkippedArticles(c.env.DB),
    getPipelineStatus(c.env.DB).catch(() => null),
    listApiOrgSummaries(c.env.DB, periodStart).catch(() => null),
    listApiKeys(c.env.DB).catch(() => null),
  ]);
  const budget = dailyNeuronBudget(c.env.DAILY_NEURON_BUDGET);
  const site = c.get("site");
  const queued = c.req.query("queued") === "1";
  const rejected = c.req.query("rejected") === "1";
  const notice =
    options.notice ??
    (c.req.query("revoked") === "1"
      ? { kind: "ok" as const, message: "Key revoked. Requests using it are rejected immediately." }
      : c.req.query("revoked") === "0"
        ? { kind: "error" as const, message: "That key was already revoked or does not exist." }
        : undefined);

  return c.render(
    <Layout
      title="Editorial desk"
      description="Review queue for Understory drafts."
      path="/admin"
      site={site}
      siteUrl={c.env.SITE_URL}
      noindex
    >
      <div class="page page--admin">
        <header class="admin-head">
          <div>
            <h1>Editorial desk</h1>
            <p class="admin-head__dek">
              Drafts wait here until a person reads them against the source snapshot.
            </p>
          </div>
          <div class="admin-head__actions">
            <form method="post" action="/admin/discover">
              <button class="button button--solid" type="submit">
                Run discovery <IconArrowRight size={14} />
              </button>
            </form>
            <form method="post" action="/admin/logout">
              <button class="button button--quiet" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </header>

        {queued ? (
          <p class="admin-flash">Discovery message queued. The pipeline worker will pick it up.</p>
        ) : null}
        {rejected ? <p class="admin-flash">Revision rejected and logged.</p> : null}

        <div class="admin-stats">
          <div>
            <span class="field-label">Published</span>
            <strong>{site.published}</strong>
          </div>
          <div>
            <span class="field-label">In review</span>
            <strong>{site.inReview}</strong>
          </div>
          <div>
            <span class="field-label">Sources</span>
            <strong>{site.sources}</strong>
          </div>
          <div>
            <span class="field-label">Edition</span>
            <strong>{site.publicationVersion}</strong>
          </div>
        </div>

        <section class="admin-queue admin-pipeline" aria-labelledby="pipeline-title">
          <div class="section-head">
            <h2 id="pipeline-title">Pipeline status</h2>
            {pipeline ? <span class="section-head__meta">{pipeline.day} UTC</span> : null}
          </div>
          {pipeline ? (
            <>
              <div class="admin-stats">
                {(["pending", "running", "deferred", "failed"] as const).map((state) => (
                  <div>
                    <span class="field-label">{state}</span>
                    <strong>{pipeline.jobs[state]}</strong>
                  </div>
                ))}
              </div>
              <p>
                AI neurons today: {pipeline.usedNeurons.toLocaleString("en-US")} used, {" "}
                {pipeline.reservedNeurons.toLocaleString("en-US")} reserved, {" "}
                {Math.max(0, budget - pipeline.usedNeurons - pipeline.reservedNeurons).toLocaleString("en-US")} remaining
                {" "}of {budget.toLocaleString("en-US")}.
              </p>
              {pipeline.recent.length ? (
                <>
                  <h3>Recent failed and deferred jobs</h3>
                  <ul>
                    {pipeline.recent.map((job) => (
                      <li>
                        <strong>{job.articleTitle ?? "Discovery"}</strong>: {job.kind}, {job.state}.
                        {" "}{job.reason}. <time dateTime={job.updatedAt}>{relativeDate(job.updatedAt)}</time>
                        {" "}<span class="admin-help__fineprint">Job {job.id}</span>
                      </li>
                    ))}
                  </ul>
                  <p class="admin-help__fineprint">Latest 10 problems. Detailed errors remain in private logs.</p>
                </>
              ) : <p class="admin-help__fineprint">No failed or deferred jobs.</p>}
            </>
          ) : <p>Pipeline status unavailable. Refresh this page to retry; the review queue remains available.</p>}
        </section>

        <section class="admin-queue admin-api" aria-labelledby="api-title">
          <div class="section-head">
            <h2 id="api-title">API access</h2>
            <span class="section-head__meta">
              Current period from {periodStart.slice(0, 10)}
            </span>
          </div>

          {notice ? (
            <p
              class={`admin-flash${notice.kind === "error" ? " admin-flash--error" : ""}`}
              role="status"
            >
              {notice.message}
            </p>
          ) : null}

          {options.minted ? (
            <div class="admin-flash" role="status" aria-live="polite">
              <strong>
                New key for {options.minted.orgId} ({options.minted.name}).
              </strong>
              <p>
                This is the only time the key is shown. Copy it into your secret manager now;
                Understory stores only a hash and cannot show it again.
              </p>
              <p>
                <code class="mono">{options.minted.plaintext}</code>
              </p>
            </div>
          ) : null}

          {apiOrgs === null ? (
            <p>API metering is unavailable. Refresh this page to retry.</p>
          ) : (
            <>
              <div class="admin-stats">
                <div>
                  <span class="field-label">Organizations</span>
                  <strong>{apiOrgs.length}</strong>
                </div>
                <div>
                  <span class="field-label">Active keys</span>
                  <strong>{apiOrgs.reduce((sum, org) => sum + org.activeKeyCount, 0)}</strong>
                </div>
                <div>
                  <span class="field-label">Requests this period</span>
                  <strong>{apiOrgs.reduce((sum, org) => sum + org.used, 0).toLocaleString("en-US")}</strong>
                </div>
              </div>

              <h3>Organizations</h3>
              {apiOrgs.length === 0 ? (
                <p class="admin-help__fineprint">
                  No organizations yet. Mint the first key below to create one.
                </p>
              ) : (
                <div class="admin-table" role="table" aria-label="API organizations">
                  <div class="admin-table__head" role="row">
                    <span role="columnheader">Organization</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Monthly limit</span>
                    <span role="columnheader">Used this period</span>
                    <span role="columnheader">Keys</span>
                  </div>
                  {apiOrgs.map((org) => {
                    const limit = org.limitCount ?? org.requestLimit;
                    return (
                      <div class="admin-table__row" role="row">
                        <span role="cell" class="admin-table__title">
                          {org.name}
                          <br />
                          <span class="mono admin-help__fineprint">{org.id}</span>
                        </span>
                        <span role="cell">
                          <span class={`status-tag status-tag--${org.status}`}>{org.status}</span>
                        </span>
                        <span role="cell">{org.requestLimit.toLocaleString("en-US")}</span>
                        <span role="cell">
                          {org.used.toLocaleString("en-US")} of {limit.toLocaleString("en-US")}
                          {" "}
                          <span class="admin-help__fineprint">
                            ({Math.max(0, limit - org.used).toLocaleString("en-US")} remaining)
                          </span>
                        </span>
                        <span role="cell">
                          {org.activeKeyCount} active of {org.keyCount}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <h3>Keys</h3>
              {apiKeys === null ? (
                <p class="admin-help__fineprint">Key list unavailable. Refresh this page to retry.</p>
              ) : apiKeys.length === 0 ? (
                <p class="admin-help__fineprint">No keys yet. Mint one below.</p>
              ) : (
                <div class="admin-table" role="table" aria-label="API keys">
                  <div class="admin-table__head" role="row">
                    <span role="columnheader">Key</span>
                    <span role="columnheader">Organization</span>
                    <span role="columnheader">Created</span>
                    <span role="columnheader">State</span>
                    <span role="columnheader" />
                  </div>
                  {apiKeys.map((key) => (
                    <div class="admin-table__row" role="row">
                      <span role="cell" class="admin-table__title">
                        <span class="mono">{key.prefix}…</span>
                        <br />
                        <span class="admin-help__fineprint">{key.name}</span>
                      </span>
                      <span role="cell">{key.orgName}</span>
                      <span role="cell">
                        <time dateTime={key.createdAt}>{relativeDate(key.createdAt)}</time>
                      </span>
                      <span role="cell">
                        {key.revokedAt === null ? (
                          <span class="status-tag status-tag--active">active</span>
                        ) : (
                          <span class="status-tag status-tag--revoked">
                            revoked <time dateTime={key.revokedAt}>{relativeDate(key.revokedAt)}</time>
                          </span>
                        )}
                      </span>
                      <span role="cell" class="admin-table__action">
                        {key.revokedAt === null ? (
                          <form method="post" action="/admin/discover">
                            <input type="hidden" name="action" value="revoke-key" />
                            <input type="hidden" name="key_id" value={key.id} />
                            <button
                              class="button button--quiet"
                              type="submit"
                              aria-label={`Revoke key ${key.prefix} for ${key.orgName}`}
                            >
                              Revoke
                            </button>
                          </form>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <h3>Create an organization and mint a key</h3>
              <p class="admin-help__fineprint">
                The plaintext key is shown once on the response to this form. It is never stored
                or logged. New organizations start on a 14-day trial; existing organizations keep
                their status and only the name and monthly limit are updated.
              </p>
              <form class="admin-action-form admin-api-form" method="post" action="/admin/discover">
                <input type="hidden" name="action" value="mint-key" />
                <div>
                  <label for="api-org-id">Organization ID</label>
                  <input
                    id="api-org-id"
                    name="org_id"
                    required
                    minlength={2}
                    maxlength={64}
                    pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,63}"
                    autocomplete="off"
                  />
                </div>
                <div>
                  <label for="api-org-name">Organization name</label>
                  <input
                    id="api-org-name"
                    name="org_name"
                    required
                    maxlength={120}
                    autocomplete="organization"
                  />
                </div>
                <div>
                  <label for="api-request-limit">Monthly request limit</label>
                  <input
                    id="api-request-limit"
                    name="request_limit"
                    type="number"
                    min={1}
                    max={10_000_000}
                    step={1}
                    value="1000"
                    required
                  />
                </div>
                <div>
                  <label for="api-key-name">Key label</label>
                  <input
                    id="api-key-name"
                    name="key_name"
                    required
                    maxlength={64}
                    value="primary"
                  />
                </div>
                <button class="button button--solid" type="submit">
                  Mint key <IconArrowRight size={14} />
                </button>
              </form>
            </>
          )}
        </section>

        <section class="admin-queue" aria-labelledby="queue-title">
          <div class="section-head">
            <h2 id="queue-title">Review queue</h2>
            <span class="section-head__meta">Oldest first</span>
          </div>

          {queue.length === 0 ? (
            <div class="empty-sheet">
              <p class="empty-sheet__title">No drafts waiting.</p>
              <p>
                Run discovery, or wait for the cron trigger. New drafts appear here after
                extraction and validation.
              </p>
            </div>
          ) : (
            <div class="admin-table" role="table" aria-label="Drafts">
              <div class="admin-table__head" role="row">
                <span role="columnheader">Revision</span>
                <span role="columnheader">Article</span>
                <span role="columnheader">Source</span>
                <span role="columnheader">Age</span>
                <span role="columnheader">Status</span>
                <span role="columnheader" />
              </div>
              {queue.map((revision) => (
                <div class="admin-table__row" role="row">
                  <span role="cell" class="mono admin-table__id">
                    {revision.id.slice(-10)}
                  </span>
                  <span role="cell" class="admin-table__title">
                    {revision.originalTitle}
                  </span>
                  <span role="cell">{revision.sourceName}</span>
                  <span role="cell">{relativeDate(revision.createdAt)}</span>
                  <span role="cell">
                    <span class={`status-tag status-tag--${revision.status}`}>
                      {revision.status}
                    </span>
                  </span>
                  <span role="cell" class="admin-table__action">
                    <a class="text-link" href={`/admin/revisions/${revision.id}`}>
                      Open <IconArrowRight size={13} />
                    </a>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section class="admin-queue" aria-labelledby="skipped-title">
          <div class="section-head">
            <h2 id="skipped-title">Recently skipped</h2>
            <span class="section-head__meta">Last 20</span>
          </div>
          {skipped.length === 0 ? (
            <p class="admin-help__fineprint">No skipped posts.</p>
          ) : (
            <div class="admin-table admin-table--skipped" role="table" aria-label="Recently skipped">
              <div class="admin-table__head" role="row">
                <span role="columnheader">Article</span>
                <span role="columnheader">Source</span>
                <span role="columnheader">Score</span>
                <span role="columnheader">Reason</span>
                <span role="columnheader">Skipped</span>
                <span role="columnheader" />
              </div>
              {skipped.map((article) => (
                <div class="admin-table__row admin-table__row--skipped" role="row">
                  <span role="cell" class="admin-table__title">{article.originalTitle}</span>
                  <span role="cell">
                    <span class="admin-table__label">Source</span>
                    <span class="admin-table__value">{article.sourceName}</span>
                  </span>
                  <span role="cell">
                    <span class="admin-table__label">Score</span>
                    <span class="admin-table__value">{article.selectionScore}</span>
                  </span>
                  <span role="cell">
                    <span class="admin-table__label">Reason</span>
                    <span class="admin-table__value">{article.selectionReason ?? "No reason recorded"}</span>
                  </span>
                  <span role="cell">
                    <span class="admin-table__label">Skipped</span>
                    <span class="admin-table__value">{relativeDate(article.skippedAt)}</span>
                  </span>
                  <span role="cell" class="admin-table__action">
                    <a class="text-link" href={article.canonicalUrl} target="_blank" rel="noopener">
                      Read source <IconArrowUpRight size={13} />
                    </a>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section class="admin-help">
          <h2>How review works</h2>
          <p>
            Approving a draft writes an immutable revision and points the article at it. Rejecting
            keeps the revision for the record and leaves the article off the public index. A
            rejected revision can only be replaced by a new generation attempt.
          </p>
          <p class="admin-help__fineprint">
            This surface is gated by the ADMIN_TOKEN secret and a same-site, http-only cookie.
            Put Cloudflare Access in front of it before using a real deployment.
          </p>
        </section>
      </div>
    </Layout>,
  );
}

function renderLogin(c: Context<AppEnv>, missingToken: boolean) {
  const site = c.get("site");
  const error = c.req.query("error") === "1";
  return c.render(
    <Layout
      title="Editorial login"
      description="Private editorial surface."
      path="/admin"
      site={site}
      siteUrl={c.env.SITE_URL}
      noindex
    >
      <div class="page page--admin">
        <div class="login-sheet">
          <h1>Editorial desk</h1>
          <p class="login-sheet__meta">Private / editorial access</p>
          {missingToken ? (
            <p class="admin-flash admin-flash--error">
              ADMIN_TOKEN is not configured. Set it with{" "}
              <code>wrangler secret put ADMIN_TOKEN</code> before using the desk.
            </p>
          ) : (
            <p>
              This page is for the person who reviews drafts. There are no public accounts.
            </p>
          )}
          {error ? <p class="admin-flash admin-flash--error">That token did not match.</p> : null}
          <form class="login-form" method="post" action="/admin/login">
            <label for="token">Editorial token</label>
            <input
              id="token"
              name="token"
              type="password"
              autocomplete="current-password"
              required
              minlength={8}
            />
            <button class="button button--solid" type="submit">
              Open the desk <IconArrowRight size={14} />
            </button>
          </form>
          <p class="admin-help__fineprint">
            For local development, the token is in <code>.dev.vars</code>. In production, use a
            long random secret and keep Cloudflare Access in front of the route.
          </p>
        </div>
      </div>
    </Layout>,
  );
}

export async function handleLogin(c: Context<AppEnv>) {
  if (bool(c.env.REQUIRE_ACCESS_JWT) && !(await verifyAccessJwt(c.req.header("cf-access-jwt-assertion"), c.env))) {
    return c.text("Unauthorized", 401);
  }
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return c.redirect("/admin");
  const body = await c.req.parseBody();
  const token = typeof body.token === "string" ? body.token : "";
  if (!(await safeEqual(token, expected))) {
    return c.redirect("/admin?error=1");
  }
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: c.env.ENVIRONMENT === "production",
    path: "/admin",
    maxAge: 60 * 60 * 8,
  });
  return c.redirect("/admin");
}

export function handleLogout(c: Context<AppEnv>) {
  deleteCookie(c, COOKIE, { path: "/admin" });
  return c.redirect("/admin");
}

export async function handleDiscover(c: Context<AppEnv>) {
  const auth = await authorize(c);
  if (!auth.ok) return c.text("Unauthorized", 401);
  const body = await c.req.parseBody();
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "mint-key") return mintApiKey(c, body);
  if (action === "revoke-key") return revokeKey(c, body);
  await c.env.PIPELINE_QUEUE.send({ kind: "discover", reason: "admin" });
  return c.redirect("/admin?queued=1");
}

/**
 * API key actions share the editorial action endpoint so they inherit the
 * admin session and same-origin POST check without a second auth path.
 */
async function mintApiKey(c: Context<AppEnv>, body: Record<string, string | File>) {
  const orgId = typeof body.org_id === "string" ? body.org_id.trim().toLowerCase() : "";
  const orgName = typeof body.org_name === "string" ? body.org_name.trim() : "";
  const keyName = typeof body.key_name === "string" ? body.key_name.trim() : "";
  const limitRaw = typeof body.request_limit === "string" ? body.request_limit.trim() : "";
  const requestLimit = Number.parseInt(limitRaw, 10);

  const invalid = (message: string) =>
    renderAdmin(c, { notice: { kind: "error", message } });

  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(orgId)) {
    return invalid("Organization ID must be 2-64 letters, digits, dashes or underscores.");
  }
  if (orgName.length < 1 || orgName.length > 120) {
    return invalid("Organization name must be 1-120 characters.");
  }
  if (keyName.length < 1 || keyName.length > 64) {
    return invalid("Key label must be 1-64 characters.");
  }
  if (!/^\d+$/.test(limitRaw) || requestLimit < 1 || requestLimit > 10_000_000) {
    return invalid("Monthly request limit must be a whole number between 1 and 10,000,000.");
  }

  const minted = await createApiKey(c.env.DB, {
    orgId,
    orgName,
    requestLimit,
    keyName,
    now: new Date(),
  });
  return renderAdmin(c, { minted });
}

async function revokeKey(c: Context<AppEnv>, body: Record<string, string | File>) {
  const keyId = typeof body.key_id === "string" ? body.key_id.trim() : "";
  if (!keyId) {
    return renderAdmin(c, {
      notice: { kind: "error", message: "Choose a key to revoke." },
    });
  }
  const revoked = await revokeApiKey(c.env.DB, keyId, new Date());
  return c.redirect(`/admin?revoked=${revoked ? 1 : 0}`);
}

export async function renderReview(c: Context<AppEnv>) {
  const auth = await authorize(c);
  if (!auth.ok) return c.redirect("/admin");

  const id = c.req.param("id");
  if (!id) return c.notFound();
  const revision = await getRevisionDetail(c.env.DB, id);
  if (!revision) return c.notFound();

  const explanation = parseExplanation(revision.contentJson);
  const provenance = parseProvenance(revision.provenanceJson);
  const validation = explanation ? validateExplanation(explanation) : null;
  const site = c.get("site");

  return c.render(
    <Layout
      title={`Review ${revision.originalTitle}`}
      description="Draft review."
      path={`/admin/revisions/${revision.id}`}
      site={site}
      siteUrl={c.env.SITE_URL}
      noindex
    >
      <div class="page page--admin">
        <nav class="breadcrumb" aria-label="Breadcrumb">
          <a href="/admin">Editorial desk</a>
          <span aria-hidden="true">/</span>
          <span>Review</span>
        </nav>

        <header class="admin-review-head">
          <div>
            <p class="field-label">
              {revision.status === "draft" ? "Draft / not published" : `Revision / ${revision.status}`}
            </p>
            <h1>{explanation?.contextHeadline ?? revision.originalTitle}</h1>
            <p class="admin-review-head__meta">
              {revision.sourceName} <span class="sep">/</span> {revision.status}{" "}
              <span class="sep">/</span> {relativeDate(revision.createdAt)}
            </p>
          </div>
          <a
            class="button button--quiet"
            href={revision.canonicalUrl}
            target="_blank"
            rel="noopener"
          >
            Read source <IconArrowUpRight size={12} />
          </a>
        </header>

        {!explanation || !validation ? (
          <div class="admin-flash admin-flash--error">
            <strong>The stored revision is not valid.</strong>
            <p>It cannot be published. Check the generation logs and create a new draft.</p>
            {validation && !validation.ok ? (
              <ul>
                {validation.issues.slice(0, 12).map((issue) => (
                  <li>
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div class="admin-review-layout">
            <div class="admin-preview">
              <p class="admin-preview__label">Reader view / draft</p>
              <h2 class="admin-preview__headline">{explanation.contextHeadline}</h2>
              <p class="admin-preview__dek">{explanation.dek}</p>
              <p class="admin-preview__sentence">{explanation.oneSentence}</p>

              <div class="admin-preview__section">
                <h3>TL;DR</h3>
                <ul>
                  {explanation.tldr.map((item) => (
                    <li>{item}</li>
                  ))}
                </ul>
              </div>

              {explanation.sections.map((section) => (
                <div class="admin-preview__section" id={section.id}>
                  <h3>{section.title}</h3>
                  <Blocks blocks={section.blocks} />
                </div>
              ))}

              <DiagramPlate diagram={explanation.diagram} figure="1" compact />

              <div class="admin-preview__section">
                <h3>The short version</h3>
                <Blocks blocks={explanation.eli5.body} />
                <p class="admin-help__fineprint">Limit: {explanation.eli5.limit}</p>
              </div>

              <div class="admin-preview__section">
                <h3>Trade-offs</h3>
                <ul>
                  {explanation.tradeoffs.map((item) => (
                    <li>
                      <strong>{item.title}</strong> {item.body}
                    </li>
                  ))}
                </ul>
              </div>

              <div class="admin-preview__section">
                <h3>Sources</h3>
                <ol>
                  {explanation.sources.map((source) => (
                    <li>
                      <a href={source.url} target="_blank" rel="noopener">
                        {source.label}
                      </a>
                      {source.note ? ` — ${source.note}` : ""}
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <aside class="admin-review-side">
              <div class="sheet-card">
                <div class="sheet-card__head">
                  <span class="field-label">Draft record</span>
                  <span class="mono">{revision.id.slice(-10)}</span>
                </div>
                <dl class="sheet-fields">
                  <div>
                    <dt>Article</dt>
                    <dd>{revision.originalTitle}</dd>
                  </div>
                  <div>
                    <dt>Publisher</dt>
                    <dd>{revision.sourceName}</dd>
                  </div>
                  <div>
                    <dt>Snapshot</dt>
                    <dd class="mono">{provenance.sourceSnapshotId ?? revision.snapshotId}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd class="mono">{provenance.modelId ?? revision.modelId}</dd>
                  </div>
                  <div>
                    <dt>Prompt</dt>
                    <dd class="mono">{provenance.promptVersion ?? revision.promptVersion}</dd>
                  </div>
                  <div>
                    <dt>Schema</dt>
                    <dd class="mono">{revision.schemaVersion}</dd>
                  </div>
                </dl>
              </div>

              {validation.ok && revision.status === "draft" ? (
                <>
                  <form class="admin-action-form" method="post" action={`/admin/revisions/${revision.id}/approve`}>
                    <label for="approve-note">Review note (optional)</label>
                    <textarea id="approve-note" name="note" rows={3} maxlength={800} />
                    <button class="button button--solid" type="submit">
                      <IconCheck size={14} /> Approve and publish
                    </button>
                  </form>

                  <form class="admin-action-form admin-action-form--reject" method="post" action={`/admin/revisions/${revision.id}/reject`}>
                    <label for="reject-note">Reason for rejection</label>
                    <textarea id="reject-note" name="note" rows={3} maxlength={800} required />
                    <button class="button button--quiet" type="submit">
                      <IconMinus size={14} /> Reject draft
                    </button>
                  </form>
                </>
              ) : validation.ok ? (
                <p class="admin-help__fineprint">
                  This revision is {revision.status}. It is a read-only record and cannot be
                  published again.
                </p>
              ) : null}

              <a class="text-link" href="/admin">
                Back to the desk
              </a>
            </aside>
          </div>
        )}
      </div>
    </Layout>,
  );
}

export async function handleApprove(c: Context<AppEnv>) {
  const auth = await authorize(c);
  if (!auth.ok) return c.text("Unauthorized", 401);
  const id = c.req.param("id");
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 800) : null;
  const result = await approveRevision(c.env.DB, id, auth.reviewer, note);
  if (!result) return c.notFound();
  const ping = pingIndexNow(c.env, [`/articles/${result.slug}`, "/"]);
  try {
    c.executionCtx.waitUntil(ping);
  } catch {
    await ping;
  }
  return c.redirect(`/articles/${result.slug}`);
}

export async function handleReject(c: Context<AppEnv>) {
  const auth = await authorize(c);
  if (!auth.ok) return c.text("Unauthorized", 401);
  const id = c.req.param("id");
  if (!id) return c.notFound();
  const body = await c.req.parseBody();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 800) : "";
  if (note.length < 3) {
    return c.text("A rejection note is required.", 400);
  }
  const ok = await rejectRevision(c.env.DB, id, auth.reviewer, note);
  if (!ok) return c.notFound();
  return c.redirect("/admin?rejected=1");
}
