import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  getSnapshotStorageReport,
  type SnapshotStorageReport,
} from "../src/infrastructure/db";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export type StorageAuditArgs = {
  mode: "local" | "remote";
  json: boolean;
  days: number;
  limit: number;
};

function positiveInteger(flag: string, value: string | undefined, max: number): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} needs a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error(`${flag} must be at most ${max}.`);
  }
  return parsed;
}

export function parseStorageAuditArgs(argv: string[], defaultDays = DEFAULT_DAYS): StorageAuditArgs {
  let mode: StorageAuditArgs["mode"] | undefined;
  let json = false;
  let days = defaultDays;
  let limit = DEFAULT_LIMIT;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--local" || arg === "--remote") {
      if (mode !== undefined) throw new Error("Pass only one of --local or --remote.");
      mode = arg === "--local" ? "local" : "remote";
      seen.add("mode");
    } else if (arg === "--json") {
      if (seen.has("json")) throw new Error("--json may only be passed once.");
      json = true;
      seen.add("json");
    } else if (arg === "--days" || arg === "--limit") {
      if (seen.has(arg)) throw new Error(`${arg} may only be passed once.`);
      seen.add(arg);
      const value = argv[++index];
      if (arg === "--days") days = positiveInteger(arg, value, MAX_DAYS);
      else limit = positiveInteger(arg, value, MAX_LIMIT);
    } else if (/^--(apply|write|delete|purge|prune|remove|force|execute|commit)(=|$)/i.test(arg ?? "")) {
      throw new Error(`${arg} is not supported; storage:audit is read-only.`);
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }

  if (mode === undefined) throw new Error("Pass exactly one of --local or --remote.");
  return { mode, json, days, limit };
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid numeric query parameter.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function interpolate(sql: string, values: unknown[]): string {
  let index = 0;
  const text = sql.replace(/\?/g, () => {
    if (index >= values.length) throw new Error("Missing query parameter.");
    return sqlLiteral(values[index++]);
  });
  if (index !== values.length) throw new Error("Unused query parameter.");
  return text;
}

export function createWranglerDb(mode: StorageAuditArgs["mode"]): D1Database {
  function query<T>(sql: string, values: unknown[]): T[] {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
      throw new Error("storage:audit only runs read-only queries.");
    }
    const command = interpolate(sql, values);
    const wranglerArgs = [
      "wrangler", "d1", "execute", "understory",
      "--config", "wrangler.jsonc",
      mode === "remote" ? "--remote" : "--local",
      "--json", "--command", command,
    ];
    if (mode === "remote") wranglerArgs.push("--yes");
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

  function prepare(sql: string): D1PreparedStatement {
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => {
        values = args;
        return statement;
      },
      all: async <T>() => ({ success: true, results: query<T>(sql, values), meta: {} }),
      first: async <T>(column?: string) => {
        const row = query<Record<string, unknown>>(sql, values)[0] ?? null;
        if (!row) return null;
        return (column ? row[column] : row) as T | null;
      },
      run: async () => {
        throw new Error("storage:audit is read-only.");
      },
    };
    return statement as unknown as D1PreparedStatement;
  }

  return { prepare } as unknown as D1Database;
}

function bytes(value: number): string {
  return `${value.toLocaleString("en-US")} bytes`;
}

export function formatStorageAudit(
  report: SnapshotStorageReport,
  target: StorageAuditArgs["mode"],
  json: boolean,
): string {
  if (json) {
    return JSON.stringify({ target, readOnly: true, ...report }, null, 2);
  }
  const lines = [
    `Target: ${target} (read-only)`,
    `Cutoff: ${report.cutoff} (strictly older than ${report.days} UTC days)`,
    `Snapshots: ${report.snapshots.total.toLocaleString("en-US")} total, ` +
      `${report.snapshots.referenced.toLocaleString("en-US")} referenced, ` +
      `${report.snapshots.unreferenced.toLocaleString("en-US")} unreferenced, ` +
      `${report.snapshots.candidates.toLocaleString("en-US")} cleanup candidates`,
    `Estimated snapshot payload: ${bytes(report.payloadBytes.total)} total, ` +
      `${bytes(report.payloadBytes.referenced)} referenced, ` +
      `${bytes(report.payloadBytes.unreferenced)} unreferenced, ` +
      `${bytes(report.payloadBytes.candidates)} candidates`,
    report.note,
    "",
    `Cleanup preview: ${report.sample.length.toLocaleString("en-US")} of ` +
      `${report.snapshots.candidates.toLocaleString("en-US")} candidates, oldest first, limit ${report.limit}`,
  ];
  if (report.sample.length === 0) {
    lines.push("  none");
  } else {
    for (const row of report.sample) {
      lines.push(
        `  ${row.snapshotId}  ${row.articleId} (${row.articleSlug})  ${row.fetchedAt}  ${bytes(row.payloadBytes)}`,
      );
    }
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseStorageAuditArgs(argv);
    const db = createWranglerDb(args.mode);
    const report = await getSnapshotStorageReport(db, { days: args.days, limit: args.limit });
    console.log(formatStorageAudit(report, args.mode, args.json));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
