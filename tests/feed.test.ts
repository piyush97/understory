import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";

const db = vi.hoisted(() => ({
  getAdjacentArticles: vi.fn(), getFeedLead: vi.fn(), getPublicationVersion: vi.fn(),
  getPublishedArticleBySlug: vi.fn(), getRevisionDetail: vi.fn(), getSiteState: vi.fn(),
  listAllPublished: vi.fn(), listFeedPage: vi.fn(), listPendingArticles: vi.fn(),
  listRelatedArticles: vi.fn(), listReviewQueue: vi.fn(), listSources: vi.fn(), listTopics: vi.fn(),
}));
vi.mock("../src/infrastructure/db", () => db);

const env = { ENVIRONMENT: "production", SITE_NAME: "Understory", SITE_URL: "https://example.com" } as Bindings;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const fetchPage = (path: string) => app.fetch(new Request(`https://example.com${path}`), env, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  db.getPublicationVersion.mockResolvedValue("1");
  db.getSiteState.mockResolvedValue({ published: 1, sources: 1, topics: 1, inReview: 0, publicationVersion: "1" });
  db.listTopics.mockResolvedValue([]);
  db.listFeedPage.mockResolvedValue({ items: [], hasMore: false });
  db.listPendingArticles.mockResolvedValue([]);
});


describe("public routes", () => {
  it("returns 404 for an unknown topic filter", async () => {
    const response = await fetchPage("/?topic=not-a-topic");
    expect(response.status).toBe(404);
  });

  it("keeps the local-only bookmarks page out of search indexes", async () => {
    const response = await fetchPage("/bookmarks");
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/name="robots" content="noindex/);
  });
});
