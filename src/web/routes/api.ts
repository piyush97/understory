import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { decodeCursor, encodeCursor } from "../../domain/pagination";
import {
  getPublishedArticleBySlug,
  listFeedPage,
} from "../../infrastructure/db";
import { parseExplanation, parseProvenance } from "../lib/content";
import { absoluteUrl } from "../lib/format";

export async function renderApiArticles(c: Context<AppEnv>) {
  const topic = c.req.query("topic")?.trim() || null;
  const cursor = decodeCursor(c.req.query("cursor"));
  const limitParam = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Number.isFinite(limitParam) ? limitParam : 20;
  const page = await listFeedPage(c.env.DB, { topic, cursor, limit });
  const last = page.items[page.items.length - 1];
  const nextCursor = page.hasMore && last
    ? encodeCursor({ publishedAt: last.publishedAt, id: last.id })
    : null;

  return c.json({
    items: page.items.map((article) => ({
      id: article.id,
      slug: article.slug,
      url: absoluteUrl(c.env.SITE_URL, `/articles/${article.slug}`),
      title: article.contextHeadline ?? article.originalTitle,
      originalTitle: article.originalTitle,
      dek: article.dek,
      source: {
        name: article.sourceName,
        url: article.sourceSiteUrl,
      },
      topic: article.topicLabel,
      publishedAt: article.publishedAt,
      readingMinutes: article.readingMinutes,
      originalUrl: article.canonicalUrl,
    })),
    nextCursor,
  });
}

export async function renderApiArticle(c: Context<AppEnv>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "not_found" }, 404);
  const article = await getPublishedArticleBySlug(c.env.DB, slug);
  if (!article) return c.json({ error: "not_found" }, 404);
  const explanation = parseExplanation(article.revisionContent);
  if (!explanation) return c.json({ error: "revision_invalid" }, 500);
  const provenance = parseProvenance(article.revisionProvenance);

  return c.json({
    id: article.id,
    slug: article.slug,
    url: absoluteUrl(c.env.SITE_URL, `/articles/${article.slug}`),
    originalTitle: article.originalTitle,
    originalUrl: article.canonicalUrl,
    source: {
      name: article.sourceName,
      url: article.sourceSiteUrl,
    },
    publishedAt: article.publishedAt,
    revision: {
      id: article.revisionId,
      reviewedBy: provenance.reviewedBy ?? null,
      modelId: provenance.modelId ?? null,
      promptVersion: provenance.promptVersion ?? null,
      schemaVersion: provenance.schemaVersion ?? null,
      sourceSnapshotId: provenance.sourceSnapshotId ?? null,
    },
    explanation,
  });
}
