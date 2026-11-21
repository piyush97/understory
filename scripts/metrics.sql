-- Read-only operating metrics for docs/metrics.md. SELECT statements only.
-- Run: npx wrangler d1 execute understory --remote --config wrangler.jsonc --json --command "$(cat scripts/metrics.sql)"
-- Results come back in statement order (1-8).

-- 1. Articles by pipeline status.
SELECT status, COUNT(*) AS articles FROM articles GROUP BY status ORDER BY articles DESC;

-- 2. Published explainers and the window they were generated in.
SELECT COUNT(*) AS published_revisions,
       COUNT(DISTINCT article_id) AS published_articles,
       MIN(created_at) AS first_generated_at,
       MAX(created_at) AS last_generated_at
FROM explanation_revisions WHERE status = 'published';

-- 3. Generation outcome: jobs that produced a revision vs jobs that ended failed.
SELECT state, COUNT(*) AS generate_jobs FROM jobs WHERE kind = 'generate' GROUP BY state ORDER BY generate_jobs DESC;

-- 4. Why failed generate jobs failed, bucketed by validator rule (first matching bucket wins;
--    one job's last_error can list several issues).
SELECT CASE
         WHEN last_error GLOB '[0-9][0-9][0-9][0-9]: *' THEN 'Workers AI error'
         WHEN last_error LIKE '%parseable JSON%' OR last_error LIKE '%output budget on reasoning%' THEN 'Malformed or empty model output'
         WHEN last_error LIKE '%Unknown citation%' THEN 'Unknown citation id'
         WHEN last_error LIKE '%not in the provided material%' OR last_error LIKE '%s1 must%' THEN 'Source URL not in material'
         WHEN last_error LIKE '%at least three sections%' THEN 'Fewer than three sections'
         WHEN last_error LIKE '%not in the allowed list%' THEN 'Topic not allowed'
         WHEN last_error LIKE '%Duplicate%' THEN 'Duplicate id'
         WHEN last_error LIKE '%Unknown node%' THEN 'Diagram edge to unknown node'
         ELSE 'Other'
       END AS reason,
       COUNT(*) AS failed_jobs
FROM jobs WHERE kind = 'generate' AND state = 'failed'
GROUP BY reason ORDER BY failed_jobs DESC;

-- 5. In-job attempt that passed validation (1 = first try, 2 = after one repair prompt).
--    Model output only: seeded fixture revisions have origin 'fixture'.
SELECT json_extract(provenance_json, '$.attempts') AS passing_attempt, COUNT(*) AS revisions
FROM explanation_revisions WHERE json_extract(provenance_json, '$.origin') = 'workers-ai'
GROUP BY passing_attempt ORDER BY passing_attempt;

-- 6. Workers AI daily neuron budget (cap: DAILY_NEURON_BUDGET = 9000 in wrangler.pipeline.jsonc).
--    reserveBudget refuses a 500-neuron reservation once used + reserved > 8500, so those days deferred work.
SELECT COUNT(*) AS days,
       MIN(day) AS first_day,
       MAX(day) AS last_day,
       SUM(used_neurons) AS used_neurons,
       ROUND(AVG(used_neurons)) AS avg_used_per_day,
       MAX(used_neurons) AS max_used_per_day,
       SUM(CASE WHEN used_neurons + reserved_neurons > 8500 THEN 1 ELSE 0 END) AS days_budget_full,
       SUM(generations) AS generation_calls
FROM ai_budget;

-- 7. Job counts by kind and state (jobs is the durable ledger behind the Queues messages).
SELECT kind, state, COUNT(*) AS jobs FROM jobs GROUP BY kind, state ORDER BY kind, state;

-- 8. Job latency for finished jobs: created_at -> updated_at (queue wait + retries + processing), seconds.
WITH finished AS (
  SELECT kind,
         (julianday(updated_at) - julianday(created_at)) * 86400.0 AS seconds,
         ROW_NUMBER() OVER (PARTITION BY kind ORDER BY julianday(updated_at) - julianday(created_at)) AS rank,
         COUNT(*) OVER (PARTITION BY kind) AS total
  FROM jobs WHERE state = 'done'
)
SELECT kind,
       total AS done_jobs,
       ROUND(AVG(seconds), 1) AS avg_s,
       ROUND(MAX(CASE WHEN rank = (total + 1) / 2 THEN seconds END), 1) AS p50_s,
       ROUND(MAX(CASE WHEN rank = (total * 95 + 99) / 100 THEN seconds END), 1) AS p95_s,
       ROUND(MAX(seconds), 1) AS max_s
FROM finished GROUP BY kind ORDER BY kind;
