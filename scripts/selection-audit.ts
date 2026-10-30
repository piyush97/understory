import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SourceBlock } from "../src/domain/source";
import {
  SELECTION_DUPLICATE_WINDOW_DAYS,
  duplicateWindowStart,
  findDuplicate,
  formatSelectionReason,
  scoreSource,
} from "../src/domain/selection";

const args = process.argv.slice(2);
const wantsLocal = args.includes("--local");
const wantsRemote = args.includes("--remote");
if (wantsLocal && wantsRemote) {
  console.error("Pass only one of --local or --remote.");
  process.exit(1);
}
const remote = wantsRemote;
const apply = args.includes("--apply");
const json = args.includes("--json");

function parseLimit(): number {
  const index = args.indexOf("--limit");
  if (index === -1) return 500;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) {
    console.error("--limit needs a number.");
    process.exit(1);
  }
  return Math.min(2000, Math.max(1, Math.floor(value)));
}
const limit = parseLimit();

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function nullable(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : quote(value);
}

function query<T>(sql: string): T[] {
  const wranglerArgs = [
    "wrangler", "d1", "execute", "understory",
    "--config", "wrangler.jsonc",
    remote ? "--remote" : "--local",
    "--json", "--command", sql,
  ];
  if (remote) wranglerArgs.push("--yes");
  const output = execFileSync("npx", wranglerArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end < start) throw new Error("No JSON in wrangler output.");
  const parsed = JSON.parse(output.slice(start, end + 1)) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

type ArticleRow = {
  id: string;
  source_id: string;
  canonical_url: string;
  original_title: string;
  slug: string;
  published_at: string;
  status: string;
  selection_score: number;
  selection_reason: string | null;
  duplicate_of: string | null;
};

type SnapshotRow = { article_id: string; blocks_json: string; word_count: number };

type Scored = {
  row: ArticleRow;
  score: number;
  skip: boolean;
  reason: string | null;
  duplicateOf: string | null;
  duplicateSlug: string | null;
};

const CANDIDATE_STATUSES = new Set(["discovered", "extracting", "generating", "review", "published"]);

const articles = query<ArticleRow>(
  `SELECT id, source_id, canonical_url, original_title, slug, published_at, status,\n` +
    `       selection_score, selection_reason, duplicate_of\n` +
    `FROM articles\nORDER BY published_at DESC\nLIMIT ${limit}`,
);

const snapshots = new Map<string, SnapshotRow>();
for (let i = 0; i < articles.length; i += 100) {
  const ids = articles.slice(i, i + 100).map((a) => quote(a.id)).join(", ");
  const rows = query<SnapshotRow>(
    `SELECT article_id, blocks_json, word_count\nFROM (\n` +
      `  SELECT article_id, blocks_json, word_count,\n` +
      `         ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY fetched_at DESC) AS rn\n` +
      `  FROM article_snapshots\n  WHERE article_id IN (${ids})\n)\nWHERE rn = 1`,
  );
  for (const row of rows) snapshots.set(row.article_id, row);
}

const bySource = new Map<string, ArticleRow[]>();
for (const row of articles) {
  const group = bySource.get(row.source_id) ?? [];
  group.push(row);
  bySource.set(row.source_id, group);
}
const duplicateByArticle = new Map<string, { id: string; slug: string }>();
for (const group of bySource.values()) {
  group.sort((a, b) => (a.published_at < b.published_at ? -1 : a.published_at > b.published_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  group.forEach((article, index) => {
    const since = duplicateWindowStart(article.published_at, SELECTION_DUPLICATE_WINDOW_DAYS);
    const candidates = group
      .slice(0, index)
      .filter((c) => CANDIDATE_STATUSES.has(c.status) && c.published_at >= since)
      .map((c) => ({ id: c.id, originalTitle: c.original_title, slug: c.slug, publishedAt: c.published_at }));
    const duplicate = findDuplicate(article.original_title, candidates);
    if (duplicate) duplicateByArticle.set(article.id, { id: duplicate.id, slug: duplicate.slug });
  });
}

const scored: Scored[] = [];
for (const row of articles) {
  const snapshot = snapshots.get(row.id);
  if (!snapshot) continue;
  const blocks = JSON.parse(snapshot.blocks_json) as SourceBlock[];
  const decision = scoreSource({
    title: row.original_title,
    url: row.canonical_url,
    blocks,
    wordCount: snapshot.word_count,
  });
  const duplicate = duplicateByArticle.get(row.id) ?? null;
  scored.push({
    row,
    score: decision.score,
    skip: decision.decision === "skip",
    reason: duplicate ? `duplicate of ${duplicate.slug}` : formatSelectionReason(decision.reasons) || null,
    duplicateOf: duplicate?.id ?? null,
    duplicateSlug: duplicate?.slug ?? null,
  });
}

const buckets: Array<[string, number, number]> = [
  ["0-19", 0, 19], ["20-34", 20, 34], ["35-44", 35, 44],
  ["45-59", 45, 59], ["60-74", 60, 74], ["75-100", 75, 100],
];
const distribution: Record<string, number> = Object.fromEntries(buckets.map(([name]) => [name, 0]));
for (const item of scored) {
  const bucket = buckets.find(([, lo, hi]) => item.score >= lo && item.score <= hi);
  if (bucket) distribution[bucket[0]] = (distribution[bucket[0]] ?? 0) + 1;
}

const view = (item: Scored) => ({
  id: item.row.id,
  slug: item.row.slug,
  title: item.row.original_title,
  sourceId: item.row.source_id,
  score: item.score,
  reason: item.reason,
});
const ranked = [...scored].sort((a, b) => a.score - b.score || (a.row.id < b.row.id ? -1 : 1));
const lowest = ranked.slice(0, 20).map(view);
const highest = ranked.slice(-20).reverse().map(view);

const clusterMap = new Map<string, string[]>();
for (const item of scored) {
  if (!item.duplicateSlug) continue;
  const members = clusterMap.get(item.duplicateSlug) ?? [];
  members.push(item.row.slug);
  clusterMap.set(item.duplicateSlug, members);
}
const clusters = [...clusterMap.entries()].map(([survivor, duplicates]) => ({ survivor, duplicates }));

const summary = {
  total: articles.length,
  scored: scored.length,
  skipped: scored.filter((s) => s.skip).length,
  duplicates: scored.filter((s) => s.duplicateOf !== null).length,
  distribution,
  lowest,
  highest,
  clusters,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Target: ${remote ? "remote" : "local"}${apply ? " (apply)" : " (read-only)"}`);
  console.log(`Total ${summary.total}, scored ${summary.scored}, skipped ${summary.skipped}, duplicates ${summary.duplicates}`);
  console.log("\nDistribution");
  for (const [name, count] of Object.entries(distribution)) console.log(`  ${name.padEnd(7)} ${count}`);
  const print = (label: string, items: ReturnType<typeof view>[]) => {
    console.log(`\n${label}`);
    for (const i of items) console.log(`  ${String(i.score).padStart(3)}  ${i.sourceId}  ${i.title}${i.reason ? `  [${i.reason}]` : ""}`);
  };
  print("Lowest 20", lowest);
  print("Highest 20", highest);
  console.log("\nDuplicate clusters");
  if (clusters.length === 0) console.log("  none");
  for (const c of clusters) console.log(`  ${c.survivor}: ${c.duplicates.join(", ")}`);
}

if (apply) {
  const statements = scored.map(
    (item) =>
      `UPDATE articles SET selection_score = ${Math.round(item.score)}, ` +
      `selection_reason = ${nullable(item.reason)}, duplicate_of = ${nullable(item.duplicateOf)} ` +
      `WHERE id = ${quote(item.row.id)};`,
  );
  if (statements.length === 0) {
    console.error("Nothing to apply.");
  } else {
    mkdirSync(".tmp", { recursive: true });
    writeFileSync(".tmp/selection-audit.sql", statements.join("\n") + "\n");
    execFileSync(
      "npx",
      [
        "wrangler", "d1", "execute", "understory",
        "--config", "wrangler.jsonc",
        remote ? "--remote" : "--local",
        "--file", ".tmp/selection-audit.sql",
        ...(remote ? ["--yes"] : []),
      ],
      { stdio: json ? ["ignore", process.stderr, process.stderr] : "inherit" },
    );
    console.error(`Applied ${statements.length} selection updates.`);
  }
}
