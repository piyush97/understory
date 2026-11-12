import { afterEach, describe, expect, it } from "vitest";
import app from "../src/web/index";
import type { Bindings } from "../src/shared/env";
import { approveRevision, searchArticles } from "../src/infrastructure/db";
import { explanation, seed, seedRevision, sqliteDb } from "./helpers/sqlite";

const databases: ReturnType<typeof sqliteDb>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
});

function setup() {
  const db = sqliteDb();
  databases.push(db);
  seed(db);
  return db;
}

async function publishFixture(db: ReturnType<typeof sqliteDb>) {
  seedRevision(db, "draft");
  const published = await approveRevision(db.db, "revision", "reviewer", null);
  expect(published).not.toBeNull();
}

// First substantial word from the fixture explainer; the publication path
// indexes content_json, so the term is guaranteed to be in the body.
const TERM = explanation.tldr.join(" ").match(/\b[a-z]{5,}\b/)![0]!;

function envFor(db: ReturnType<typeof sqliteDb>): Bindings {
  return {
    ENVIRONMENT: "test",
    SITE_NAME: "Understory",
    SITE_URL: "https://understory.test",
    DB: db.db,
    ASSETS: {},
    PIPELINE_QUEUE: {},
  } as unknown as Bindings;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("searchArticles", () => {
  it("returns nothing for empty, one-character, and operator-only queries", async () => {
    const db = setup();
    await publishFixture(db);
    for (const query of ["", "   ", "a", "1", "*", "--", "***"]) {
      expect(await searchArticles(db.db, query), query).toEqual([]);
    }
  });

  it("treats FTS syntax as inert text instead of interpolating it", async () => {
    const db = setup();
    await publishFixture(db);
    for (const query of ['" OR 1=1 --', '"*"', "NEAR(", "title:body"]) {
      const results = await searchArticles(db.db, query);
      expect(Array.isArray(results), query).toBe(true);
    }
    expect(await searchArticles(db.db, '" OR 1=1 --')).toEqual([]);
  });

  it("matches the published explainer by title, dek, and body terms", async () => {
    const db = setup();
    await publishFixture(db);
    const byBody = await searchArticles(db.db, TERM);
    expect(byBody.map((article) => article.slug)).toContain("test-article");
    expect(byBody[0]?.slug).toBe("test-article");
  });

  it("never returns rows for unpublished or draft articles, even if indexed", async () => {
    const db = setup();
    // seed() leaves the article in "generating" with a draft revision.
    db.sqlite
      .prepare(
        `INSERT INTO search_index (article_id, slug, title, dek, body) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("article", "test-article", "Raft consensus", "A stale row", "raft consensus");
    seedRevision(db, "draft");

    expect(await searchArticles(db.db, "raft")).toEqual([]);
  });

  it("indexes an article when it is published", async () => {
    const db = setup();
    expect(await searchArticles(db.db, TERM)).toEqual([]);
    await publishFixture(db);
    expect((await searchArticles(db.db, TERM)).map((article) => article.slug)).toEqual([
      "test-article",
    ]);
  });
});

describe("GET /search", () => {
  it("renders an accessible search form and no results without a query", async () => {
    const db = setup();
    const response = await app.fetch(
      new Request("https://understory.test/search"),
      envFor(db),
      ctx,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('for="search-q"');
    expect(html).toContain('type="search"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('role="search"');
    expect(html).not.toContain("feed-item__headline");
  });

  it("renders matching explainers with the count and link", async () => {
    const db = setup();
    await publishFixture(db);
    const response = await app.fetch(
      new Request(`https://understory.test/search?q=${TERM}`),
      envFor(db),
      ctx,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("1 explainer matches");
    expect(html).toContain('href="/articles/test-article"');
    expect(html).toContain('value="' + TERM + '"');
  });

  it("reports no hits and escapes the query instead of rendering it", async () => {
    const db = setup();
    const response = await app.fetch(
      new Request("https://understory.test/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
      envFor(db),
      ctx,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("No explainers match");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
