import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { FIXTURE_ARTICLES, type FixtureArticle } from "../src/content/fixtures";
import { TOPIC_SEEDS } from "../src/content/topics";
import { validateExplanation } from "../src/domain/explanation";

const remote = process.argv.includes("--remote");
const printOnly = process.argv.includes("--print");

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function nullable(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : quote(value);
}

function statementsFor(fixture: FixtureArticle): string[] {
  const statements: string[] = [];
  const { source, topic, article, snapshot, explanation } = fixture;

  statements.push(
    `INSERT INTO sources (id, name, site_url, host, feed_url)\n` +
      `VALUES (${quote(source.id)}, ${quote(source.name)}, ${quote(source.siteUrl)}, ${quote(source.host)}, ${nullable(source.feedUrl)})\n` +
      `ON CONFLICT (id) DO UPDATE SET name = excluded.name, site_url = excluded.site_url, host = excluded.host, feed_url = excluded.feed_url;`,
  );

  statements.push(
    `INSERT INTO topics (id, label, description, sort_order)\n` +
      `VALUES (${quote(topic.id)}, ${quote(topic.label)}, ${quote(topic.description)}, ${topic.sortOrder})\n` +
      `ON CONFLICT (id) DO UPDATE SET label = excluded.label, description = excluded.description, sort_order = excluded.sort_order;`,
  );

  if (explanation) {
    const validation = validateExplanation(explanation);
    if (!validation.ok) {
      throw new Error(
        `Fixture ${article.slug} is invalid:\n${validation.issues
          .map((issue) => `  ${issue.path}: ${issue.message}`)
          .join("\n")}`,
      );
    }
  }

  const revisionId = explanation ? `rev_${article.id}` : null;
  const contextHeadline = explanation?.contextHeadline ?? null;
  const dek = explanation?.dek ?? null;
  const readingMinutes = explanation?.readingMinutes ?? null;
  const topicId = explanation?.topic ?? null;

  statements.push(
    `INSERT INTO articles\n` +
      `  (id, source_id, canonical_url, original_title, published_at, discovered_at, author, summary, slug, status, context_headline, dek, topic_id, reading_minutes, published_revision_id)\n` +
      `VALUES (${quote(article.id)}, ${quote(source.id)}, ${quote(article.canonicalUrl)}, ${quote(article.originalTitle)}, ${quote(article.publishedAt)}, ${quote(article.discoveredAt)}, ${nullable(article.author)}, ${nullable(article.summary)}, ${quote(article.slug)}, ${quote(article.status)}, ${nullable(contextHeadline)}, ${nullable(dek)}, ${nullable(topicId)}, ${readingMinutes === null ? "NULL" : String(readingMinutes)}, ${nullable(revisionId)})\n` +
      `ON CONFLICT (id) DO UPDATE SET\n` +
      `  source_id = excluded.source_id,\n` +
      `  canonical_url = excluded.canonical_url,\n` +
      `  original_title = excluded.original_title,\n` +
      `  published_at = excluded.published_at,\n` +
      `  discovered_at = excluded.discovered_at,\n` +
      `  author = excluded.author,\n` +
      `  summary = excluded.summary,\n` +
      `  slug = excluded.slug,\n` +
      `  status = excluded.status,\n` +
      `  context_headline = excluded.context_headline,\n` +
      `  dek = excluded.dek,\n` +
      `  topic_id = excluded.topic_id,\n` +
      `  reading_minutes = excluded.reading_minutes,\n` +
      `  published_revision_id = excluded.published_revision_id,\n` +
      `  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');`,
  );

  statements.push(
    `INSERT INTO article_topics (article_id, topic_id) VALUES (${quote(article.id)}, ${quote(topic.id)}) ON CONFLICT DO NOTHING;`,
  );

  if (snapshot) {
    statements.push(
      `INSERT INTO article_snapshots\n` +
        `  (id, article_id, source_hash, blocks_json, word_count, extractor_version, fetched_at, final_url, http_status)\n` +
        `VALUES (${quote(snapshot.id)}, ${quote(article.id)}, ${quote(snapshot.sourceHash)}, ${quote(JSON.stringify(snapshot.blocks))}, ${snapshot.wordCount}, ${quote("fixture-1")}, ${quote(snapshot.fetchedAt)}, ${quote(snapshot.finalUrl)}, ${snapshot.httpStatus})\n` +
        `ON CONFLICT (article_id, source_hash) DO UPDATE SET\n` +
        `  blocks_json = excluded.blocks_json,\n` +
        `  word_count = excluded.word_count,\n` +
        `  fetched_at = excluded.fetched_at;`,
    );
  }

  if (explanation && snapshot && revisionId) {
    const provenance = JSON.stringify({
      origin: "fixture",
      modelId: "editorial-fixture",
      promptVersion: "fixture-1",
      schemaVersion: "1",
      generatedAt: snapshot.fetchedAt,
      reviewedBy: "Understory editorial",
      sourceSnapshotId: snapshot.id,
    });
    const reviewNote =
      "Seeded edition. Written from the linked source, reviewed before publication.";
    statements.push(
      `INSERT INTO explanation_revisions\n` +
        `  (id, article_id, snapshot_id, status, content_json, provenance_json, model_id, prompt_version, schema_version, reviewed_at, reviewed_by, review_note)\n` +
        `VALUES (${quote(revisionId)}, ${quote(article.id)}, ${quote(snapshot.id)}, ${quote("published")}, ${quote(JSON.stringify(explanation))}, ${quote(provenance)}, ${quote("editorial-fixture")}, ${quote("fixture-1")}, ${quote("1")}, ${quote(snapshot.fetchedAt)}, ${quote("Understory editorial")}, ${quote(reviewNote)})\n` +
        `ON CONFLICT (id) DO UPDATE SET\n` +
        `  status = excluded.status,\n` +
        `  content_json = excluded.content_json,\n` +
        `  provenance_json = excluded.provenance_json,\n` +
        `  reviewed_at = excluded.reviewed_at,\n` +
        `  reviewed_by = excluded.reviewed_by,\n` +
        `  review_note = excluded.review_note;`,
    );
    statements.push(
      `INSERT INTO reviews (id, revision_id, decision, note, reviewer, created_at)\n` +
        `VALUES (${quote(`revw_${revisionId}`)}, ${quote(revisionId)}, 'approved', ${quote(reviewNote)}, ${quote("Understory editorial")}, ${quote(snapshot.fetchedAt)})\n` +
        `ON CONFLICT (id) DO UPDATE SET\n` +
        `  decision = excluded.decision,\n` +
        `  note = excluded.note,\n` +
        `  reviewer = excluded.reviewer,\n` +
        `  created_at = excluded.created_at;`,
    );
  }

  return statements;
}

const published = FIXTURE_ARTICLES.filter((fixture) => fixture.article.status === "published").length;
const header = `-- Generated by scripts/seed.ts. Do not edit.\n`;
const footer = `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'publication_version';\n`;
const sql =
  header +
  [
    ...TOPIC_SEEDS.map(
      (topic) =>
        `INSERT INTO topics (id, label, description, sort_order)\n` +
        `VALUES (${quote(topic.id)}, ${quote(topic.label)}, ${quote(topic.description)}, ${topic.sortOrder})\n` +
        `ON CONFLICT (id) DO UPDATE SET label = excluded.label, description = excluded.description, sort_order = excluded.sort_order;`,
    ),
    ...FIXTURE_ARTICLES.flatMap(statementsFor),
  ].join("\n\n") +
  "\n" +
  footer;

mkdirSync(".tmp", { recursive: true });
writeFileSync(".tmp/seed.sql", sql);
console.log(`Wrote .tmp/seed.sql (${(sql.length / 1024).toFixed(1)} KiB, ${published} published articles).`);

if (!printOnly) {
  const args = [
    "wrangler",
    "d1",
    "execute",
    "understory",
    "--config",
    "wrangler.jsonc",
    remote ? "--remote" : "--local",
    "--file",
    ".tmp/seed.sql",
  ];
  if (remote) args.push("--yes");
  execFileSync("npx", args, { stdio: "inherit" });
}
