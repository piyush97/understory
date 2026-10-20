import { afterEach, describe, expect, it, vi } from "vitest";
import { runDiscovery } from "../src/pipeline/run";
import type { Bindings } from "../src/shared/env";
import { seed, sqliteDb } from "./helpers/sqlite";

afterEach(() => vi.unstubAllGlobals());

describe("discovery fetch integration", () => {
  it("rejects an oversized listing before writing discovery state", async () => {
    const store = sqliteDb();
    seed(store);
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(700_001)); },
      cancel,
    }))));
    const env = { DB: store.db, SITE_URL: "https://understory.example" } as Bindings;
    try {
      await expect(runDiscovery(env, "test")).rejects.toThrow(/byte limit/i);
      expect(cancel).toHaveBeenCalled();
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(0);
    } finally { store.sqlite.close(); }
  });

  it("rejects a redirect to private metadata before a second fetch", async () => {
    const store = sqliteDb();
    seed(store);
    const fetch = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "http://169.254.169.254/latest" },
    }));
    vi.stubGlobal("fetch", fetch);
    const env = { DB: store.db, SITE_URL: "https://understory.example" } as Bindings;
    try {
      await expect(runDiscovery(env, "test")).rejects.toThrow(/non-public/i);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { store.sqlite.close(); }
  });
});
