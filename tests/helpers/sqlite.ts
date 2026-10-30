import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { FIXTURE_ARTICLES } from "../../src/content/fixtures";

export function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(new URL("../../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  let beforeBatch: (() => Promise<void> | void) | undefined;
  let failStatement: string | undefined;
  const executions = new WeakMap<D1PreparedStatement, () => unknown>();
  function prepare(sql: string, values: SQLInputValue[] = []): D1PreparedStatement {
    const execute = () => {
      if (failStatement && sql.includes(failStatement)) throw new Error("injected write failure");
      const statement = sqlite.prepare(sql);
      const results = statement.all(...values);
      return { success: true, results, meta: { changes: Number(sqlite.prepare("SELECT changes() AS n").get()?.n ?? 0) } };
    };
    const prepared = {
      bind: (...args: unknown[]) => prepare(sql, args as SQLInputValue[]),
      first: async (column?: string) => {
        const row = execute().results[0] ?? null;
        return column && row ? row[column] : row;
      },
      all: async () => execute(),
      run: async () => execute(),
    } as D1PreparedStatement;
    executions.set(prepared, execute);
    return prepared;
  }
  const db = {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      const hook = beforeBatch;
      beforeBatch = undefined;
      await hook?.();
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => executions.get(statement)!());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return {
    db, sqlite,
    beforeBatch: (hook: () => Promise<void> | void) => { beforeBatch = hook; },
    failOn: (text?: string) => { failStatement = text; },
  };
}

export const explanation = FIXTURE_ARTICLES.find((item) => item.article.status === "published")!.explanation!;
export const articleInput = {
  id: "article", sourceId: "source", canonicalUrl: "https://example.com/post", originalTitle: "Test article",
  publishedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), slug: "test-article",
};

export function seed(db: ReturnType<typeof sqliteDb>) {
  db.sqlite.prepare("INSERT INTO sources (id, name, site_url, host) VALUES ('source', 'Source', 'https://example.com', 'example.com')").run();
  db.sqlite.prepare("INSERT INTO articles (id, source_id, canonical_url, original_title, published_at, discovered_at, slug, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'generating')")
    .run(articleInput.id, articleInput.sourceId, articleInput.canonicalUrl, articleInput.originalTitle, articleInput.publishedAt, articleInput.discoveredAt, articleInput.slug);
  db.sqlite.prepare("INSERT INTO article_snapshots (id, article_id, source_hash, blocks_json, word_count, extractor_version, fetched_at) VALUES ('snapshot', 'article', 'hash', '[]', 300, 'test', ?)").run(new Date().toISOString());
}

export function seedRevision(db: ReturnType<typeof sqliteDb>, status = "draft") {
  db.sqlite.prepare("INSERT INTO explanation_revisions (id, article_id, snapshot_id, status, content_json, provenance_json, model_id, prompt_version, schema_version) VALUES ('revision', 'article', 'snapshot', ?, ?, '{}', 'model', 'prompt', 'schema')")
    .run(status, JSON.stringify(explanation));
}
