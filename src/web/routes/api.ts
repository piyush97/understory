import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { decodeCursor, encodeCursor } from "../../domain/pagination";
import {
  getPublishedArticleBySlug,
  listFeedPage,
} from "../../infrastructure/db";
import { parseExplanation } from "../lib/content";
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

/**
 * Free summary of one explainer. The full explainer body, revisions, and the
 * change feed are the paid API (/api/v1); this route points callers there.
 */
export async function renderApiArticle(c: Context<AppEnv>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "not_found" }, 404);
  const article = await getPublishedArticleBySlug(c.env.DB, slug);
  if (!article) return c.json({ error: "not_found" }, 404);
  const explanation = parseExplanation(article.revisionContent);
  if (!explanation) return c.json({ error: "revision_invalid" }, 500);
  return c.json({
    id: article.id,
    slug: article.slug,
    url: absoluteUrl(c.env.SITE_URL, `/articles/${article.slug}`),
    title: explanation.contextHeadline,
    originalTitle: article.originalTitle,
    originalUrl: article.canonicalUrl,
    dek: explanation.dek,
    oneSentence: explanation.oneSentence,
    tldr: explanation.tldr,
    topic: article.topicLabel,
    source: {
      name: article.sourceName,
      url: article.sourceSiteUrl,
    },
    publishedAt: article.publishedAt,
    readingMinutes: explanation.readingMinutes,
    fullExplainer: {
      api: absoluteUrl(c.env.SITE_URL, `/api/v1/articles/${article.id}`),
      docs: absoluteUrl(c.env.SITE_URL, "/developers"),
    },
  });
}
