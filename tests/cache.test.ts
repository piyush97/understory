import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ getSiteState: vi.fn(), getPublicationVersion: vi.fn() }));
vi.mock("../src/infrastructure/db", () => db);

function ctx(url: string): any {
  const store = new Map<string, unknown>();
  return {
    env: { ENVIRONMENT: "production", DB: {} },
    req: { url },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => void store.set(key, value),
    executionCtx: { waitUntil: (p: Promise<unknown>) => void p },
  };
}

function stubCache(hit = false) {
  const keys: string[] = [];
  const cache = {
    match: async () => (hit ? new Response("cached") : undefined),
    put: (r: Request) => { keys.push(r.url); return Promise.resolve(); },
  };
  vi.stubGlobal("caches", { default: cache });
  return keys;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

async function load() {
  return (await import("../src/web/lib/cache")).cachePage;
}

describe("cachePage key", () => {
  it("ignores unknown query params", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const cachePage = await load();
    const keys = stubCache();
    await cachePage(ctx("https://x.test/?utm=1&x=2"), 60, () => new Response("a"));
    await cachePage(ctx("https://x.test/?x=3"), 60, () => new Response("a"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("keeps topic and cursor", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const cachePage = await load();
    const keys = stubCache();
    await cachePage(ctx("https://x.test/?topic=db&cursor=abc&x=1"), 60, () => new Response("a"));
    const url = new URL(keys[0]!);
    expect(url.searchParams.get("topic")).toBe("db");
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(url.searchParams.has("x")).toBe(false);
    expect(url.searchParams.get("__v")).toBe("7");
  });
});

describe("cachePage site state", () => {
  it("loads the full site state only when rendering", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    db.getSiteState.mockResolvedValue({ published: 3, publicationVersion: "7" });
    const cachePage = await load();
    stubCache(false);
    const c = ctx("https://x.test/");
    const response = await cachePage(c, 60, () => {
      expect(c.get("site")).toMatchObject({ published: 3 });
      return new Response("fresh");
    });
    expect(await response.text()).toBe("fresh");
    expect(db.getSiteState).toHaveBeenCalledTimes(1);
  });

  it("skips the counting queries on a cache hit", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const cachePage = await load();
    stubCache(true);
    const render = vi.fn(() => new Response("fresh"));
    const response = await cachePage(ctx("https://x.test/"), 60, render);
    expect(await response.text()).toBe("cached");
    expect(render).not.toHaveBeenCalled();
    expect(db.getSiteState).not.toHaveBeenCalled();
  });

  it("reuses the publication version for 30 seconds", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const cachePage = await load();
    stubCache(false);
    await cachePage(ctx("https://x.test/"), 60, () => new Response("a"));
    await cachePage(ctx("https://x.test/about"), 60, () => new Response("b"));
    expect(db.getPublicationVersion).toHaveBeenCalledTimes(1);
  });
});
