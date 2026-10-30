import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";
import type { SkippedArticle } from "../src/infrastructure/db";

const db = vi.hoisted(() => ({
  approveRevision: vi.fn(),
  getRevisionDetail: vi.fn(),
  listReviewQueue: vi.fn(),
  listRecentSkippedArticles: vi.fn(async (): Promise<SkippedArticle[]> => []),
  rejectRevision: vi.fn(),
}));
vi.mock("../src/infrastructure/db", () => ({
  ...db,
  getSiteState: vi.fn(async () => ({ published: 1, sources: 1, topics: 0, inReview: 0, publicationVersion: "1" })),
  getPublicationVersion: vi.fn(async () => "1"),
}));

const env = {
  ADMIN_TOKEN: "test-token",
  REQUIRE_ACCESS_JWT: "false",
  ENVIRONMENT: "production",
  SITE_NAME: "Understory",
  SITE_URL: "https://example.com",
  DB: {},
  ASSETS: {},
  PIPELINE_QUEUE: {},
} as unknown as Bindings;

const skipped: SkippedArticle = {
  id: "skip-1",
  originalTitle: "Introducing Widget 2.0",
  canonicalUrl: "https://example.com/widget",
  sourceName: "Example",
  selectionScore: 32,
  selectionReason: "release/announcement title (-30)",
  skippedAt: "2026-10-29T00:00:00.000Z",
};

function request() {
  return app.fetch(
    new Request("https://example.com/admin", { headers: { authorization: "Bearer test-token" } }),
    env,
    {} as ExecutionContext,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.listReviewQueue.mockResolvedValue([]);
  db.listRecentSkippedArticles.mockResolvedValue([]);
});

describe("admin skipped list", () => {
  it("renders recently skipped posts with source, score and reason immediately after the review queue", async () => {
    db.listRecentSkippedArticles.mockResolvedValue([skipped]);

    const response = await request();
    expect(response.status).toBe(200);
    const { document } = parseHTML(await response.text());
    const section = document.querySelector('[aria-labelledby="skipped-title"]');
    expect(section?.previousElementSibling?.getAttribute("aria-labelledby")).toBe("queue-title");
    expect(section?.nextElementSibling?.className).toBe("admin-help");
    expect(section?.querySelector("h2")?.textContent).toBe("Recently skipped");
    expect(section?.querySelector(".section-head__meta")?.textContent).toBe("Last 20");
    const cells = section?.querySelectorAll(".admin-table__row > [role=cell]");
    expect(cells?.[0]?.textContent).toBe("Introducing Widget 2.0");
    expect(cells?.[1]?.querySelector(".admin-table__value")?.textContent).toBe("Example");
    expect(cells?.[2]?.querySelector(".admin-table__value")?.textContent).toBe("32");
    expect(cells?.[3]?.querySelector(".admin-table__value")?.textContent).toBe("release/announcement title (-30)");
    expect(cells?.[4]?.querySelector(".admin-table__value")?.textContent).toBeTruthy();
    const link = section?.querySelector("a.text-link");
    expect(link?.getAttribute("href")).toBe("https://example.com/widget");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
    expect(link?.textContent).toContain("Read source");
    expect(section?.querySelectorAll("button")).toHaveLength(0);
  });

  it("scopes skipped layout modifiers and labels its source, score, reason and time", async () => {
    db.listRecentSkippedArticles.mockResolvedValue([skipped]);

    const { document } = parseHTML(await (await request()).text());
    const section = document.querySelector('[aria-labelledby="skipped-title"]');
    expect(section?.querySelector(".admin-table")?.classList.contains("admin-table--skipped")).toBe(true);
    expect(section?.querySelector(".admin-table__row")?.classList.contains("admin-table__row--skipped")).toBe(true);
    expect([...section!.querySelectorAll(".admin-table__label")].map((label) => label.textContent))
      .toEqual(["Source", "Score", "Reason", "Skipped"]);
    expect(document.querySelector('[aria-labelledby="queue-title"]')?.querySelector("[class*=skipped]")).toBeNull();
  });

  it("renders an empty state when nothing has been skipped", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const { document } = parseHTML(await response.text());
    const section = document.querySelector('[aria-labelledby="skipped-title"]');
    expect(section?.querySelector("h2")?.textContent).toBe("Recently skipped");
    expect(section?.querySelector(".admin-help__fineprint")?.textContent).toBe("No skipped posts.");
    expect(section?.querySelector(".admin-table")).toBeNull();
  });

  it("escapes source-controlled titles and selection reasons in the server response", async () => {
    db.listRecentSkippedArticles.mockResolvedValue([{
      ...skipped,
      originalTitle: '<script>alert("title")</script>',
      selectionReason: '<img src=x onerror="alert(1)"> & reason',
    }]);

    const response = await request();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp; reason");
    expect(html).not.toContain('<script>alert("title")</script>');
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    const { document } = parseHTML(html);
    const row = document.querySelector('[aria-labelledby="skipped-title"] .admin-table__row');
    expect(row?.querySelector("script, img")).toBeNull();
    const cells = row?.querySelectorAll("[role=cell]");
    expect(cells?.[0]?.textContent).toBe('<script>alert("title")</script>');
    expect(cells?.[3]?.querySelector(".admin-table__value")?.textContent).toBe('<img src=x onerror="alert(1)"> & reason');
  });

  it("explains when no selection reason was recorded", async () => {
    db.listRecentSkippedArticles.mockResolvedValue([{ ...skipped, selectionReason: null }]);

    const { document } = parseHTML(await (await request()).text());
    const cells = document.querySelectorAll('[aria-labelledby="skipped-title"] .admin-table__row > [role=cell]');
    expect(cells[3]?.querySelector(".admin-table__value")?.textContent).toBe("No reason recorded");
  });
});
