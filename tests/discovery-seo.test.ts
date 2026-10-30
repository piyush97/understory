import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";
import { pingIndexNow } from "../src/shared/indexnow";
import { articleJsonLd } from "../src/web/routes/article";
import { explanation } from "./helpers/sqlite";
import type { PublishedArticle } from "../src/domain/article";

const db = vi.hoisted(() => ({
  getAdjacentArticles: vi.fn(), getFeedLead: vi.fn(), getPublicationVersion: vi.fn(),
  getPublishedArticleBySlug: vi.fn(), getRevisionDetail: vi.fn(), getSiteState: vi.fn(),
  listAllPublished: vi.fn(), listFeedPage: vi.fn(), listPendingArticles: vi.fn(),
  listRelatedArticles: vi.fn(), listReviewQueue: vi.fn(), listSources: vi.fn(), listTopics: vi.fn(),
  listRecentSkippedArticles: vi.fn(async () => []),
  listPublishedIndex: vi.fn(), listRecentPublishedContent: vi.fn(),
}));
vi.mock("../src/infrastructure/db", () => db);

const baseEnv = { ENVIRONMENT: "production", SITE_NAME: "Understory", SITE_URL: "https://example.com" };
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const get = (path: string, extra: Record<string, string> = {}) =>
  app.fetch(new Request(`https://example.com${path}`), { ...baseEnv, ...extra } as Bindings, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  db.getPublicationVersion.mockResolvedValue("1");
  db.getSiteState.mockResolvedValue({ published: 1, sources: 1, topics: 1, inReview: 0, publicationVersion: "1" });
  db.listTopics.mockResolvedValue([]);
  db.listFeedPage.mockResolvedValue({ items: [], hasMore: false });
  db.listPendingArticles.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe("llms.txt", () => {
  it("lists published explainers grouped by topic with absolute links", async () => {
    db.listPublishedIndex.mockResolvedValue([
      { slug: "raft", headline: "How Raft elects a leader", dek: "Terms and\nvotes.", sourceName: "etcd", topicLabel: "Distributed systems", publishedAt: "2026-10-01T00:00:00.000Z" },
      { slug: "misc", headline: "Untopiced post", dek: null, sourceName: "Blog", topicLabel: null, publishedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    const response = await get("/llms.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toMatch(/^# Understory\n\n> /);
    expect(body).toContain("## Distributed systems");
    expect(body).toContain("- [How Raft elects a leader](https://example.com/articles/raft): Terms and votes. (etcd)");
    expect(body).toContain("## Other");
    expect(body).toContain("https://example.com/llms-full.txt");
  });
});

describe("llms-full.txt", () => {
  it("renders explainer text and skips unparseable revisions", async () => {
    db.listRecentPublishedContent.mockResolvedValue([
      { slug: "good", canonicalUrl: "https://src.example/post", sourceName: "Src", publishedAt: "2026-10-01T00:00:00.000Z", content: JSON.stringify(explanation) },
      { slug: "bad", canonicalUrl: "https://src.example/bad", sourceName: "Src", publishedAt: "2026-10-01T00:00:00.000Z", content: "{" },
    ]);
    const body = await (await get("/llms-full.txt")).text();
    expect(body).toContain(`## ${explanation.contextHeadline}`);
    expect(body).toContain("URL: https://example.com/articles/good");
    expect(body).toContain("Original: https://src.example/post (Src)");
    expect(body).toContain(`### ${explanation.sections[0]!.title}`);
    expect(body).not.toContain("articles/bad");
  });
});

describe("robots and head links", () => {
  it("points agents at llms.txt from robots.txt", async () => {
    const body = await (await get("/robots.txt")).text();
    expect(body).toContain("# Agent index: https://example.com/llms.txt");
    expect(body).toContain("Disallow: /admin");
  });

  it("advertises llms.txt and site JSON-LD on the homepage", async () => {
    db.getFeedLead.mockResolvedValue(null);
    const html = await (await get("/")).text();
    expect(html).toContain('href="/llms.txt"');
    const json = JSON.parse(/application\/ld\+json">(.*?)<\/script>/s.exec(html)![1]!);
    expect(json["@graph"].map((node: { "@type": string }) => node["@type"])).toEqual(["WebSite", "Organization"]);
  });
});

describe("IndexNow key file", () => {
  it("serves the configured key and 404s otherwise", async () => {
    const key = "a1b2c3d4e5f60718";
    const ok = await get(`/${key}.txt`, { INDEXNOW_KEY: key });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(key);
    expect((await get("/zzzzzzzzzzzz.txt", { INDEXNOW_KEY: key })).status).toBe(404);
    expect((await get(`/${key}.txt`)).status).toBe(404);
  });
});

describe("pingIndexNow", () => {
  it("posts absolute URLs with the key location in production", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const sent = await pingIndexNow({ ...baseEnv, INDEXNOW_KEY: "k".repeat(16) }, ["/articles/raft", "/"]);
    expect(sent).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(String(init.body))).toEqual({
      host: "example.com",
      key: "k".repeat(16),
      keyLocation: `https://example.com/${"k".repeat(16)}.txt`,
      urlList: ["https://example.com/articles/raft", "https://example.com/"],
    });
  });

  it("does nothing without a key or outside production, and never throws", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", fetchMock);
    expect(await pingIndexNow(baseEnv, ["/"])).toBe(false);
    expect(await pingIndexNow({ ...baseEnv, ENVIRONMENT: "development", INDEXNOW_KEY: "k".repeat(16) }, ["/"])).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await pingIndexNow({ ...baseEnv, INDEXNOW_KEY: "k".repeat(16) }, ["/"])).toBe(false);
  });
});

describe("article JSON-LD", () => {
  it("includes modified date, breadcrumbs, and topic", () => {
    const article = {
      slug: "raft", publishedAt: "2026-10-01T00:00:00.000Z", author: null, sourceName: "etcd",
      canonicalUrl: "https://etcd.io/raft", topicId: "distributed-systems", topicLabel: "Distributed systems",
    } as PublishedArticle;
    const ld = articleJsonLd("https://example.com", article, explanation, "2026-10-02T00:00:00.000Z");
    const [node, crumbs] = ld["@graph"] as Array<Record<string, unknown>>;
    expect(node).toMatchObject({
      "@type": "Article",
      dateModified: "2026-10-02T00:00:00.000Z",
      mainEntityOfPage: "https://example.com/articles/raft",
      about: "Distributed systems",
      isBasedOn: "https://etcd.io/raft",
    });
    expect((crumbs!.itemListElement as unknown[]).length).toBe(3);
  });
});
