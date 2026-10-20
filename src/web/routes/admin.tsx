import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../../shared/env";
import { bool } from "../../shared/env";
import {
  approveRevision,
  getRevisionDetail,
  listReviewQueue,
  rejectRevision,
} from "../../infrastructure/db";
import { Layout } from "../components/layout";
import { Blocks } from "../components/blocks";
import { DiagramPlate } from "../components/diagram";
import { validateExplanation } from "../../domain/explanation";
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
    const email = c.req.header("cf-access-authenticated-user-email");
    if (!email) return { ok: false, missingToken: false };
    return { ok: true, reviewer: email };
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

export async function renderAdmin(c: Context<AppEnv>) {
  const auth = await authorize(c);
  if (!auth.ok) return renderLogin(c, auth.missingToken);

  const queue = await listReviewQueue(c.env.DB);
  const site = c.get("site");
  const queued = c.req.query("queued") === "1";
  const rejected = c.req.query("rejected") === "1";

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
  await c.env.PIPELINE_QUEUE.send({ kind: "discover", reason: "admin" });
  return c.redirect("/admin?queued=1");
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
