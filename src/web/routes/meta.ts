import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import {
  listAllPublished,
  listFeedPage,
  listPublishedIndex,
  listRecentPublishedContent,
} from "../../infrastructure/db";
import type { Block, Inline } from "../../domain/explanation";
import { absoluteUrl } from "../lib/format";
import { parseExplanation } from "../lib/content";

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
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "",
    `# Agent index: ${absoluteUrl(c.env.SITE_URL, "/llms.txt")}`,
    `Sitemap: ${sitemap}`,
    "",
  ].join("\n");
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

const SITE_SUMMARY =
  "Understory turns new engineering blog posts into explainers: context, how the mechanism works, a diagram, trade-offs, and cited sources. Every explainer links to the original post.";

// Markdown one-liners must not break the list structure.
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export async function renderLlmsTxt(c: Context<AppEnv>) {
  const entries = await listPublishedIndex(c.env.DB);
  const url = (path: string) => absoluteUrl(c.env.SITE_URL, path);
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = entry.topicLabel ?? "Other";
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  const lines = [
    "# Understory",
    "",
    `> ${SITE_SUMMARY}`,
    "",
    "Explainers are generated from extracted source text and validated automatically; they are not human fact-checked. Cite the original publisher linked on each page.",
    "",
    "## Machine-readable",
    "",
    `- [Full text of recent explainers](${url("/llms-full.txt")}): plain text of the newest 50`,
    `- [Articles API](${url("/api/articles")}): JSON list; \`/api/articles/<slug>\` returns one explainer`,
    `- [RSS feed](${url("/feed.xml")}): newest 50`,
    `- [Sitemap](${url("/sitemap.xml")})`,
    "",
  ];
  for (const [topic, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${oneLine(topic)}`, "");
    for (const entry of list) {
      const dek = entry.dek ? `: ${oneLine(entry.dek)}` : "";
      lines.push(`- [${oneLine(entry.headline)}](${url(`/articles/${entry.slug}`)})${dek} (${oneLine(entry.sourceName)})`);
    }
    lines.push("");
  }
  return c.text(lines.join("\n"), 200, { "Content-Type": "text/plain; charset=utf-8" });
}

function runsText(runs: Inline[]): string {
  return runs.map((run) => run.text).join("");
}

function blockText(block: Block): string {
  switch (block.type) {
    case "p":
      return runsText(block.runs);
    case "quote":
      return `> ${runsText(block.runs)}`;
    case "note":
      return `${block.title}: ${runsText(block.runs)}`;
    case "list":
      return block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : "-"} ${runsText(item)}`).join("\n");
    case "code":
      return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
  }
}

export async function renderLlmsFullTxt(c: Context<AppEnv>) {
  const rows = await listRecentPublishedContent(c.env.DB, 50);
  const parts = [`# Understory: recent explainers`, "", `> ${SITE_SUMMARY}`, ""];
  for (const row of rows) {
    const explanation = parseExplanation(row.content);
    if (!explanation) continue;
    parts.push(
      `## ${oneLine(explanation.contextHeadline)}`,
      "",
      `URL: ${absoluteUrl(c.env.SITE_URL, `/articles/${row.slug}`)}`,
      `Original: ${row.canonicalUrl} (${oneLine(row.sourceName)})`,
      `Published: ${row.publishedAt.slice(0, 10)}`,
      "",
      explanation.dek,
      "",
      "TL;DR:",
      ...explanation.tldr.map((item) => `- ${item}`),
      "",
    );
    for (const section of explanation.sections) {
      parts.push(`### ${section.title}`, "", ...section.blocks.map(blockText).flatMap((text) => [text, ""]));
    }
    parts.push("### Trade-offs", "", ...explanation.tradeoffs.map((t) => `- ${t.title}: ${t.body}`), "", "---", "");
  }
  return c.text(parts.join("\n"), 200, { "Content-Type": "text/plain; charset=utf-8" });
}
