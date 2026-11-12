import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";
import type { SkippedArticle } from "../src/infrastructure/db";
import { billingPeriodStart, sha256Hex } from "../src/web/lib/api-auth";
import { sqliteDb } from "./helpers/sqlite";

const db = vi.hoisted(() => ({
  approveRevision: vi.fn(),
  getRevisionDetail: vi.fn(),
  listReviewQueue: vi.fn(),
  listRecentSkippedArticles: vi.fn(async (): Promise<SkippedArticle[]> => []),
  getPipelineStatus: vi.fn(),
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
  DAILY_NEURON_BUDGET: "9500",
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

let database: ReturnType<typeof sqliteDb>;

beforeEach(() => {
  vi.clearAllMocks();
  database = sqliteDb();
  env.DB = database.db;
  db.listReviewQueue.mockResolvedValue([]);
  db.listRecentSkippedArticles.mockResolvedValue([]);
  db.getPipelineStatus.mockResolvedValue({
    day: "2026-11-04", jobs: { pending: 0, running: 0, deferred: 0, failed: 0 },
    usedNeurons: 0, reservedNeurons: 0, recent: [],
  });
});

afterEach(() => {
  database.sqlite.close();
});

describe("admin pipeline status", () => {
  it("shows the effective budget and an honest empty job state", async () => {
    const { document } = parseHTML(await (await request()).text());
    const section = document.querySelector('[aria-labelledby="pipeline-title"]');
    expect(section?.textContent).toContain("2026-11-04 UTC");
    expect(section?.textContent).toContain("9,000 remaining");
    expect(section?.textContent).toContain("No failed or deferred jobs.");
    expect(section?.querySelectorAll("button, a")).toHaveLength(0);
  });

  it("shows job counts, safe reasons and a clamped remaining budget", async () => {
    db.getPipelineStatus.mockResolvedValue({
      day: "2026-11-04", jobs: { pending: 2, running: 1, deferred: 3, failed: 4 },
      usedNeurons: 8900, reservedNeurons: 500,
      recent: [{ id: "job-1", kind: "generate", state: "failed", articleTitle: "<img src=x>",
        reason: "Validation failed", updatedAt: "2026-11-04T00:00:00.000Z" }],
    });
    const { document } = parseHTML(await (await request()).text());
    const section = document.querySelector('[aria-labelledby="pipeline-title"]');
    expect([...section!.querySelectorAll(".admin-stats strong")].map((node) => node.textContent))
      .toEqual(["2", "1", "3", "4"]);
    expect(section?.textContent).toContain("8,900 used");
    expect(section?.textContent).toContain("500 reserved");
    expect(section?.textContent).toContain("0 remaining");
    expect(section?.textContent).toContain("Validation failed");
    expect(section?.textContent).toContain("<img src=x>");
    expect(section?.querySelector("img")).toBeNull();
  });

  it("keeps the review queue usable when telemetry fails, without leaking the error", async () => {
    db.getPipelineStatus.mockRejectedValue(new Error("secret-token-never-display"));
    const response = await request();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Pipeline status unavailable");
    expect(html).toContain("Review queue");
    expect(html).not.toContain("secret-token-never-display");
  });

  it("does not read or show telemetry to an anonymous visitor", async () => {
    const response = await app.fetch(new Request("https://example.com/admin"), env, {} as ExecutionContext);
    expect(await response.text()).not.toContain('id="pipeline-title"');
    expect(db.getPipelineStatus).not.toHaveBeenCalled();
  });
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

describe("admin API key management", () => {
  const ctx = {} as ExecutionContext;

  type KeyRow = {
    id: string;
    org_id: string;
    prefix: string;
    key_hash: string;
    revoked_at: string | null;
  };

  const keyRows = () =>
    database.sqlite
      .prepare("SELECT id, org_id, prefix, key_hash, revoked_at FROM api_keys")
      .all() as unknown as KeyRow[];

  function post(
    body: Record<string, string>,
    options: { authorize?: boolean; origin?: string } = {},
  ) {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      origin: options.origin ?? "https://example.com",
    };
    if (options.authorize !== false) headers.authorization = `Bearer ${env.ADMIN_TOKEN}`;
    return app.fetch(
      new Request("https://example.com/admin/discover", {
        method: "POST",
        headers,
        body: new URLSearchParams(body).toString(),
      }),
      env,
      ctx,
    );
  }

  async function mint(orgId: string, orgName: string, limit = "1000", keyName = "primary") {
    const response = await post({
      action: "mint-key",
      org_id: orgId,
      org_name: orgName,
      request_limit: limit,
      key_name: keyName,
    });
    const html = await response.text();
    const plaintext = html.match(/us_(?:test|live)_[0-9a-f]{48}/)?.[0];
    return { response, html, plaintext };
  }

  function useKey(plaintext: string) {
    return app.fetch(
      new Request("https://example.com/api/v1/usage", {
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      env,
      ctx,
    );
  }

  it("rejects unauthenticated and cross-origin key mutations", async () => {
    const anonymous = await post(
      { action: "mint-key", org_id: "acme", org_name: "Acme", request_limit: "1000", key_name: "primary" },
      { authorize: false },
    );
    expect(anonymous.status).toBe(401);

    const crossOrigin = await post(
      { action: "mint-key", org_id: "acme", org_name: "Acme", request_limit: "1000", key_name: "primary" },
      { origin: "https://evil.example" },
    );
    expect(crossOrigin.status).toBe(403);

    expect(keyRows()).toHaveLength(0);
  });

  it("mints a key, stores only its hash, and shows the plaintext once", async () => {
    const { response, html, plaintext } = await mint("acme", "Acme", "2500");

    expect(response.status).toBe(200);
    expect(plaintext).toBeTruthy();
    expect(html).toContain("only time the key is shown");
    expect(html.match(new RegExp(plaintext!, "g"))).toHaveLength(1);

    const rows = keyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.org_id).toBe("acme");
    expect(rows[0]?.prefix).toBe(plaintext!.slice(0, 12));
    expect(rows[0]?.key_hash).toBe(await sha256Hex(plaintext!));
    expect(rows[0]?.revoked_at).toBeNull();

    const org = database.sqlite
      .prepare("SELECT name, status, request_limit FROM api_orgs WHERE id = ?")
      .get("acme") as unknown as { name: string; status: string; request_limit: number };
    expect(org).toMatchObject({ name: "Acme", status: "trial", request_limit: 2500 });

    const stored = JSON.stringify(database.sqlite.prepare("SELECT * FROM api_keys").all());
    expect(stored).not.toContain(plaintext!);

    const page = await (await request()).text();
    expect(page).not.toContain(plaintext!);
  });

  it("revokes a key immediately without touching another organization's key", async () => {
    const first = await mint("acme", "Acme");
    const second = await mint("globex", "Globex");
    expect(first.plaintext).toBeTruthy();
    expect(second.plaintext).toBeTruthy();

    expect((await useKey(first.plaintext!)).status).toBe(200);

    const acmeKey = keyRows().find((row) => row.org_id === "acme")!;
    const revoked = await post({ action: "revoke-key", key_id: acmeKey.id });
    expect(revoked.status).toBe(302);
    expect(revoked.headers.get("location")).toBe("/admin?revoked=1");

    expect((await useKey(first.plaintext!)).status).toBe(401);
    expect((await useKey(second.plaintext!)).status).toBe(200);

    const rows = keyRows();
    expect(rows.find((row) => row.org_id === "acme")?.revoked_at).toBeTruthy();
    expect(rows.find((row) => row.org_id === "globex")?.revoked_at).toBeNull();

    const again = await post({ action: "revoke-key", key_id: acmeKey.id });
    expect(again.headers.get("location")).toBe("/admin?revoked=0");
  });

  it("renders current-period usage counters from api_usage", async () => {
    await mint("acme", "Acme", "2500");
    const period = billingPeriodStart(new Date());
    database.sqlite
      .prepare("INSERT INTO api_usage (org_id, period_start, used, limit_count) VALUES (?, ?, ?, ?)")
      .run("acme", period, 210, 2500);

    const { document } = parseHTML(await (await request()).text());
    const section = document.querySelector('[aria-labelledby="api-title"]');
    expect(section?.textContent).toContain("Current period from");
    expect(section?.textContent).toContain("Acme");
    expect(section?.textContent).toContain("210 of 2,500");
    expect(section?.textContent).toContain("2,290 remaining");
    expect(section?.textContent).toContain("1 active of 1");
  });

  it("escapes organization names and scopes key rows to their organization", async () => {
    const hostile = '<img src=x onerror="alert(1)"> & Co';
    await mint("acme", hostile);
    await mint("globex", "Globex");

    const html = await (await request()).text();
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('<img src=x');

    const { document } = parseHTML(html);
    const section = document.querySelector('[aria-labelledby="api-title"]');
    expect(section?.querySelector("img")).toBeNull();

    const orgRows = [
      ...section!.querySelectorAll('[aria-label="API organizations"] .admin-table__row'),
    ];
    expect(orgRows.some((row) => row.textContent?.includes(hostile))).toBe(true);

    const keyRowsEls = [...section!.querySelectorAll('[aria-label="API keys"] .admin-table__row')];
    expect(keyRowsEls).toHaveLength(2);
    const orgCells = keyRowsEls.map((row) => row.querySelectorAll("[role=cell]")[1]?.textContent);
    expect(orgCells).toContain(hostile);
    expect(orgCells).toContain("Globex");
  });
});
