import type { SourceBlock, SourceSnapshot } from "../domain/source";

export const EXTRACTOR_VERSION = "htmlrewriter-1";

export type ExtractedArticle = {
  title: string | null;
  author: string | null;
  summary: string | null;
  canonicalUrl: string | null;
  blocks: SourceBlock[];
  wordCount: number;
  links: Array<{ url: string; host: string }>;
};

type RawBlock = {
  kind: SourceBlock["kind"];
  text: string;
  order: number;
  headingLevel?: 1 | 2 | 3;
};

const NOISE_SELECTOR = [
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
  "noscript",
  "svg",
  "button",
  "[aria-hidden='true']",
  ".share",
  ".sharing",
  ".social",
  ".newsletter",
  ".subscribe",
  ".cookie",
  ".comments",
  "#comments",
  ".related-posts",
  ".recommended",
  ".advertisement",
  ".ad",
].join(", ");

const ROOT_SELECTOR = [
  "article",
  "main",
  "[role='main']",
  ".post-content",
  ".entry-content",
  ".post__content",
  ".post-body",
  ".article-body",
  ".blog-post",
  ".post",
  "#content",
  ".content",
].join(", ");

/**
 * Pull readable prose out of a publisher page. We never send the raw HTML to
 * the model: the snapshot is a bounded set of blocks with a heading path, so a
 * citation can point at something a person can actually find again.
 */
export async function extractArticle(html: string, pageUrl: string): Promise<ExtractedArticle> {
  const meta = new Map<string, string>();
  const rootBlocks: RawBlock[] = [];
  const fallbackBlocks: RawBlock[] = [];
  const links: Array<{ url: string; host: string }> = [];
  const seenLinks = new Set<string>();
  let rootDepth = 0;
  let sawRoot = false;
  let order = 0;

  const rewriter = new HTMLRewriter()
    .on(NOISE_SELECTOR, {
      element(element) {
        element.remove();
      },
    })
    .on(ROOT_SELECTOR, {
      element(element) {
        if (rootDepth === 0) sawRoot = true;
        rootDepth += 1;
        element.onEndTag(() => {
          rootDepth = Math.max(0, rootDepth - 1);
        });
      },
    })
    .on("meta", {
      element(element) {
        const key = (
          element.getAttribute("property") ??
          element.getAttribute("name") ??
          ""
        ).toLowerCase();
        const content = element.getAttribute("content");
        if (key && content && !meta.has(key)) meta.set(key, content);
      },
    })
    .on("link[rel='canonical']", {
      element(element) {
        const href = element.getAttribute("href");
        if (href && !meta.has("canonical")) meta.set("canonical", href);
      },
    })
    .on("a[href]", {
      element(element) {
        if (rootDepth <= 0) return;
        const href = element.getAttribute("href");
        if (!href) return;
        try {
          const url = new URL(href, pageUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") return;
          url.hash = "";
          if (url.href === pageUrl) return;
          if (seenLinks.has(url.href) || links.length >= 30) return;
          if (isSocialHost(url.hostname)) return;
          seenLinks.add(url.href);
          links.push({ url: url.href, host: url.hostname.replace(/^www\./, "") });
        } catch {
          // Ignore malformed hrefs.
        }
      },
    });

  addBlockHandler(rewriter, "h1", "heading", 1, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);
  addBlockHandler(rewriter, "h2", "heading", 2, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);
  addBlockHandler(rewriter, "h3", "heading", 3, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);
  addBlockHandler(rewriter, "p", "paragraph", undefined, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);
  addBlockHandler(rewriter, "li", "list", undefined, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);
  addBlockHandler(rewriter, "pre", "code", undefined, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);
  addBlockHandler(rewriter, "blockquote", "quote", undefined, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);
  addBlockHandler(rewriter, "figcaption", "caption", undefined, rootBlocks, fallbackBlocks, () => rootDepth, () => order++);

  // Handlers fire while the transformed stream is consumed.
  await rewriter.transform(new Response(html)).text();

  const raw = cleanBlocks(sawRoot && rootBlocks.length > 0 ? rootBlocks : fallbackBlocks);
  const blocks = assignBlocks(raw, pageUrl);
  const wordCount = Math.max(
    1,
    blocks.reduce((total, block) => total + block.text.split(/\s+/).filter(Boolean).length, 0),
  );

  const title =
    meta.get("og:title") ??
    meta.get("twitter:title") ??
    firstHeading(raw) ??
    meta.get("title") ??
    null;

  return {
    title: title ? decodeBasicEntities(title).slice(0, 400) : null,
    author: meta.get("author") ?? meta.get("article:author") ?? null,
    summary: meta.get("description") ?? meta.get("og:description") ?? null,
    canonicalUrl: meta.get("canonical") ?? null,
    blocks,
    wordCount,
    links,
  };
}

function addBlockHandler(
  rewriter: HTMLRewriter,
  selector: string,
  kind: SourceBlock["kind"],
  headingLevel: 1 | 2 | 3 | undefined,
  rootBlocks: RawBlock[],
  fallbackBlocks: RawBlock[],
  rootDepth: () => number,
  nextOrder: () => number,
): void {
  const stack: Array<{ text: string }> = [];
  rewriter.on(selector, {
    element(element) {
      const buffer = { text: "" };
      stack.push(buffer);
      element.onEndTag(() => {
        const current = stack.pop();
        if (!current) return;
        const text =
          kind === "code"
            ? current.text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim()
            : normalizeText(current.text);
        if (!isUseful(text, kind)) return;
        const target = rootDepth() > 0 ? rootBlocks : fallbackBlocks;
        target.push({
          kind,
          text: text.slice(0, kind === "code" ? 6_000 : 4_000),
          order: nextOrder(),
          headingLevel,
        });
      });
    },
    text(chunk) {
      const current = stack[stack.length - 1];
      if (current) current.text += chunk.text;
    },
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUseful(text: string, kind: SourceBlock["kind"]): boolean {
  if (text.length < 2) return false;
  if (!/[a-z0-9]/i.test(text)) return false;
  if (kind !== "heading" && text.length < 18) return false;
  if (kind !== "code" && kind !== "heading" && text.length > 4_000) return false;
  if (/^(share|tweet|subscribe|sign up|advertisement|cookie|accept all|read more)\b/i.test(text)) {
    return false;
  }
  return true;
}

function cleanBlocks(blocks: RawBlock[]): RawBlock[] {
  const ordered = [...blocks].sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const unique: RawBlock[] = [];

  for (const block of ordered) {
    const key = `${block.kind}:${block.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(block);
  }

  // A list item that merely repeats a paragraph (common in "key points" markup)
  // adds no evidence value. Keep the paragraph and drop the duplicate.
  const paragraphs = unique.filter((block) => block.kind === "paragraph" || block.kind === "quote");
  const filtered = unique.filter((block) => {
    if (block.kind !== "list") return true;
    return !paragraphs.some(
      (paragraph) =>
        Math.abs(paragraph.order - block.order) <= 8 &&
        paragraph.text.length >= block.text.length &&
        paragraph.text.includes(block.text),
    );
  });

  let budget = 52_000;
  const capped: RawBlock[] = [];
  for (const block of filtered) {
    if (capped.length >= 220 || budget <= 0) break;
    const text = block.text.slice(0, Math.min(block.text.length, budget));
    if (!text) continue;
    capped.push({ ...block, text });
    budget -= text.length;
  }
  return capped;
}

function assignBlocks(blocks: RawBlock[], pageUrl: string): SourceBlock[] {
  const headingPath: string[] = [];
  return blocks.map((block, index) => {
    if (block.kind === "heading" && block.headingLevel) {
      headingPath.length = Math.min(headingPath.length, block.headingLevel - 1);
      headingPath[block.headingLevel - 1] = block.text.slice(0, 160);
    }
    return {
      id: `b${index + 1}`,
      kind: block.kind,
      text: block.text,
      sourceUrl: pageUrl,
      headingPath: headingPath.filter(Boolean).slice(0, 6),
    };
  });
}

function firstHeading(blocks: RawBlock[]): string | null {
  return blocks.find((block) => block.kind === "heading" && block.headingLevel === 1)?.text ?? null;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isSocialHost(hostname: string): boolean {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  return [
    "twitter.com",
    "x.com",
    "facebook.com",
    "linkedin.com",
    "reddit.com",
    "news.ycombinator.com",
    "instagram.com",
    "youtube.com",
    "pinterest.com",
    "threads.net",
    "bsky.app",
    "mastodon.social",
  ].some((social) => host === social || host.endsWith(`.${social}`));
}

export type FetchedPage = {
  html: string;
  finalUrl: string;
  status: number;
};

export async function fetchArticlePage(url: string, userAgent: string): Promise<FetchedPage> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en",
    },
    signal: AbortSignal.timeout(20_000),
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
  }
  if (!response.ok) throw new Error(`Source responded ${response.status}`);

  const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (declared > 8_000_000) throw new Error("Source page is too large");

  const html = await response.text();
  if (html.length > 8_000_000) throw new Error("Source page is too large");

  return { html, finalUrl: response.url || url, status: response.status };
}

export function toSnapshot(
  articleId: string,
  pageUrl: string,
  fetchedAt: string,
  extracted: ExtractedArticle,
): SourceSnapshot {
  return {
    articleId,
    title: extracted.title ?? "Untitled source",
    url: pageUrl,
    fetchedAt,
    extractorVersion: EXTRACTOR_VERSION,
    blocks: extracted.blocks,
    wordCount: extracted.wordCount,
  };
}
