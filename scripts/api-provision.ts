import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const remote = args.includes("--remote");
const printOnly = args.includes("--print");
const orgId = flag("--org", "");
const name = flag("--name", orgId);
const status = flag("--status", "trial");
const limit = flag("--limit", "1000");

if (!orgId) {
  console.error(
    "Usage: npm run api:provision -- --org <id> --name <name> [--status trial|active] [--limit 1000] [--remote] [--print]",
  );
  process.exit(1);
}
if (!["trial", "active", "past_due", "canceled"].includes(status)) {
  console.error(`Unknown status: ${status}`);
  process.exit(1);
}

const bytes = crypto.getRandomValues(new Uint8Array(24));
const key = `us_${status === "trial" ? "test" : "live"}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const now = new Date();
const trialEndsAt = status === "trial" ? new Date(now.getTime() + 14 * 86_400_000).toISOString() : null;
const paidThrough = status === "active" ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() : null;

const sql = `INSERT INTO api_orgs (id, name, status, request_limit, trial_ends_at, paid_through, created_at, updated_at)
VALUES (${quote(orgId)}, ${quote(name)}, ${quote(status)}, ${Number.parseInt(limit, 10)}, ${
  trialEndsAt ? quote(trialEndsAt) : "NULL"
}, ${paidThrough ? quote(paidThrough) : "NULL"}, ${quote(now.toISOString())}, ${quote(now.toISOString())})
ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status,
  request_limit = excluded.request_limit, trial_ends_at = excluded.trial_ends_at,
  paid_through = excluded.paid_through, updated_at = excluded.updated_at;

INSERT INTO api_keys (id, org_id, name, prefix, key_hash, created_at)
VALUES (${quote(crypto.randomUUID())}, ${quote(orgId)}, 'primary', ${quote(key.slice(0, 12))}, ${quote(hash)}, ${quote(now.toISOString())});
`;

mkdirSync(".tmp", { recursive: true });
writeFileSync(".tmp/api-key.sql", sql);

if (!printOnly) {
  const execArgs = [
    "wrangler",
    "d1",
    "execute",
    "understory",
    "--config",
    "wrangler.jsonc",
    remote ? "--remote" : "--local",
    "--file",
    ".tmp/api-key.sql",
  ];
  if (remote) execArgs.push("--yes");
  execFileSync("npx", execArgs, { stdio: "inherit" });
}

console.log(`Organization: ${orgId} (${status}, ${limit} requests per month)`);
console.log(`API key (shown once): ${key}`);
