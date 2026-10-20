import { describe, expect, it } from "vitest";
import { createJob, renewJobLease } from "../src/infrastructure/db";
import { seed, sqliteDb } from "./helpers/sqlite";

describe("lease renewal", () => {
  it("extends a lease instead of shortening it", async () => {
    const store = sqliteDb();
    seed(store);
    try {
      await createJob(store.db, {
        id: "job",
        kind: "extract",
        articleId: "article",
        idempotencyKey: "extract:article",
        payload: {},
      });
      const claimed = store.sqlite
        .prepare("UPDATE jobs SET state = 'running', lease_token = 'token', lease_expires_at = ? WHERE id = 'job'")
        .run(new Date(Date.now() + 240_000).toISOString());
      expect(claimed.changes).toBe(1);

      const job = {
        id: "job",
        kind: "extract" as const,
        articleId: "article",
        payloadJson: "{}",
        state: "running" as const,
        attempts: 1,
        idempotencyKey: "extract:article",
        leaseToken: "token",
        leaseExpiresAt: new Date(Date.now() + 240_000).toISOString(),
        nextRunAt: new Date().toISOString(),
        lastError: null,
      };

      expect(await renewJobLease(store.db, job, 240)).toBe(true);
      const expiry = Date.parse(
        String(store.sqlite.prepare("SELECT lease_expires_at FROM jobs WHERE id = 'job'").get()?.lease_expires_at),
      );
      expect(expiry).toBeGreaterThan(Date.parse(job.leaseExpiresAt));
    } finally {
      store.sqlite.close();
    }
  });
});
