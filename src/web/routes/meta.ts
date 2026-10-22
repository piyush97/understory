import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { listAllPublished, listFeedPage } from "../../infrastructure/db";
import { absoluteUrl } from "../lib/format";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderRobots(c: Context<AppEnv>) {
  const sitemap = absoluteUrl(c.env.SITE_URL, "/sitemap.xml");
  const body = ["User-agent: *", "Allow: /", "Disallow: /admin", "", `Sitemap: ${sitemap}`, ""].join(
    "\n",
  );
  return c.text(body, 200, { "Content-Type": "text/plain; charset=utf-8" });
}

export async function renderSitemap(c: Context<AppEnv>) {
  const [articles] = await Promise.all([listAllPublished(c.env.DB)]);
  // Topic pages are indexable (own title + canonical); list those with published articles.
  const topicLastmod = new Map<string, string>();
  for (const article of articles) {
    if (article.topicId && !topicLastmod.has(article.topicId)) topicLastmod.set(article.topicId, article.updatedAt.slice(0, 10));
  }
  const urls = [
    { loc: absoluteUrl(c.env.SITE_URL, "/"), lastmod: null },
    { loc: absoluteUrl(c.env.SITE_URL, "/topics"), lastmod: null },
    { loc: absoluteUrl(c.env.SITE_URL, "/sources"), lastmod: null },
    { loc: absoluteUrl(c.env.SITE_URL, "/about"), lastmod: null },
    ...[...topicLastmod].map(([topic, lastmod]) => ({
      loc: absoluteUrl(c.env.SITE_URL, `/?topic=${encodeURIComponent(topic)}`),
      lastmod,
    })),
    ...articles.map((article) => ({
      loc: absoluteUrl(c.env.SITE_URL, `/articles/${article.slug}`),
      lastmod: article.updatedAt.slice(0, 10),
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (entry) =>
      `  <url><loc>${escapeXml(entry.loc)}</loc>${
        entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ""
      }</url>`,
  )
  .join("\n")}
</urlset>
`;
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8" });
}

export async function renderFeedXml(c: Context<AppEnv>) {
  const page = await listFeedPage(c.env.DB, { limit: 50 });
  const items = page.items
    .map((article) => {
      const url = absoluteUrl(c.env.SITE_URL, `/articles/${article.slug}`);
      const title = article.contextHeadline ?? article.originalTitle;
      const description = article.dek ?? article.summary ?? "";
      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${new Date(article.publishedAt).toUTCString()}</pubDate>
      <description>${escapeXml(description)}</description>
      <category>${escapeXml(article.topicLabel ?? "Engineering")}</category>
      <source url="${escapeXml(article.canonicalUrl)}">${escapeXml(article.sourceName)}</source>
    </item>`;
    })
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Understory</title>
    <link>${escapeXml(absoluteUrl(c.env.SITE_URL, "/"))}</link>
    <description>Engineering blogs, explained. Reviewed explainers with context, diagrams, and sources.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  return c.body(body, 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
}
