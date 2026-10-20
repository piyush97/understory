import { canonicalizeUrl, hostOf } from "../domain/source";

export type DiscoveredPost = {
  title: string;
  url: string;
  sourceName: string;
  sourceSiteUrl: string;
  publishedAt: string;
};

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((month, index) => [month, index] as const),
);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

export function parseHeadingDate(value: string): string | null {
  const match = value
    .trim()
    .match(
      /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/,
    );
  if (!match) return null;
  const month = MONTHS.get((match[1] ?? "").toLowerCase());
  const day = Number.parseInt(match[2] ?? "", 10);
  const year = Number.parseInt(match[3] ?? "", 10);
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  const date = new Date(Date.UTC(year, month, day, 12, 0, 0));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

/**
 * engineeringblogs.xyz publishes a deliberately simple page: date headings
 * followed by div.entry blocks with a source link and a title link. Parse that
 * shape directly, but fail soft: one malformed entry must not hide the rest.
 */
export function parseDiscoveryHtml(html: string): DiscoveredPost[] {
  const posts: DiscoveredPost[] = [];
  const seen = new Set<string>();
  let currentDate: string | null = null;

  const token = /<h2[^>]*>([\s\S]*?)<\/h2>|<div\s+class=["']entry["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const match of html.matchAll(token)) {
    if (match[1] !== undefined) {
      currentDate = parseHeadingDate(decodeEntities(match[1].replace(/<[^>]+>/g, "")));
      continue;
    }

    const block = match[2] ?? "";
    const source = block.match(
      /<span\s+class=["']source["'][^>]*>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    const title = block.match(
      /<span\s+class=["']title["'][^>]*>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!source || !title) continue;

    let url: string;
    let sourceSiteUrl: string;
    try {
      url = canonicalizeUrl(decodeEntities(title[1] ?? ""));
      sourceSiteUrl = canonicalizeUrl(decodeEntities(source[1] ?? ""));
    } catch {
      continue;
    }

    if (seen.has(url)) continue;
    seen.add(url);

    const cleanTitle = decodeEntities((title[2] ?? "").replace(/<[^>]+>/g, ""));
    const cleanSource = decodeEntities((source[2] ?? "").replace(/<[^>]+>/g, ""));
    if (!cleanTitle || !cleanSource) continue;

    posts.push({
      title: cleanTitle,
      url,
      sourceName: cleanSource,
      sourceSiteUrl,
      publishedAt: currentDate ?? new Date().toISOString(),
    });
  }

  return posts;
}

export type FeedOutline = {
  name: string;
  siteUrl: string;
  feedUrl: string;
  host: string;
};

/**
 * OPML is optional: discovery itself is enough to learn the sources that have
 * recent posts. The outline feed is still useful for seeding the source table.
 */
export function parseOpml(xml: string): FeedOutline[] {
  const outlines: FeedOutline[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<outline\b([^>]*?)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const feedUrl = attribute(attrs, "xmlUrl");
    const siteUrl = attribute(attrs, "htmlUrl") ?? feedUrl;
    const name = attribute(attrs, "title") ?? attribute(attrs, "text");
    if (!feedUrl || !siteUrl || !name) continue;
    if (!isHttpUrl(feedUrl) || !isHttpUrl(siteUrl)) continue;

    let host: string;
    try {
      host = hostOf(siteUrl);
    } catch {
      continue;
    }
    if (!host || seen.has(host)) continue;
    seen.add(host);
    outlines.push({ name, siteUrl, feedUrl, host });
  }
  return outlines;
}

function attribute(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match?.[1] ? decodeEntities(match[1]) : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
