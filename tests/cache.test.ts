import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getSiteState: vi.fn(),
  getPublicationVersion: vi.fn(),
  getPublishedRevisionIdBySlug: vi.fn(),
  listTopics: vi.fn(),
}));
vi.mock("../src/infrastructure/db", () => db);

function ctx(url: string, waits: Promise<unknown>[] = []): any {
  const store = new Map<string, unknown>();
  return {
    env: { ENVIRONMENT: "production", DB: {} },
    req: { url },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => void store.set(key, value),
    executionCtx: { waitUntil: (p: Promise<unknown>) => { waits.push(p); } },
  };
}

function stubCache(hit = false) {
  const keys: string[] = [];
  const cache = {
    match: async () => (hit ? new Response("cached") : undefined),
    put: (r: Request) => {
      if (!r.url.startsWith("https://site-state.internal/")) keys.push(r.url);
      return Promise.resolve();
    },
  };
  vi.stubGlobal("caches", { default: cache });
  return keys;
}

function stubSiteStateCache(options: { hit?: unknown; fail?: boolean } = {}) {
  const puts: Array<{ url: string; body: string; cacheControl: string | null }> = [];
  const cache = {
    match: async () => {
      if (options.fail) throw new Error("cache down");
      if (options.hit === undefined) return undefined;
      return new Response(JSON.stringify(options.hit));
    },
    put: async (key: Request, response: Response) => {
      if (options.fail) throw new Error("cache down");
      puts.push({
        url: key.url,
        body: await response.text(),
        cacheControl: response.headers.get("Cache-Control"),
      });
    },
  };
  vi.stubGlobal("caches", { default: cache });
  return puts;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

async function load() {
  return (await import("../src/web/lib/cache")).cachePage;
}

async function loadCachedSiteState() {
  return (await import("../src/web/lib/cache")).cachedSiteState;
}

async function loadCachedTopics() {
  return (await import("../src/web/lib/cache")).cachedTopics;
}

describe("cachedSiteState", () => {
  it("returns the cached state without running the count query on a hit", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const cachedSiteState = await loadCachedSiteState();
    const cached = { published: 9, sources: 4, topics: 2, inReview: 1, publicationVersion: "7" };
    stubSiteStateCache({ hit: cached });
    const state = await cachedSiteState(ctx("https://x.test/"));
    expect(state).toEqual(cached);
    expect(db.getSiteState).not.toHaveBeenCalled();
  });

  it("stores the fresh state under the publication version on a miss", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const fresh = { published: 3, sources: 1, topics: 2, inReview: 0, publicationVersion: "7" };
    db.getSiteState.mockResolvedValue(fresh);
    const cachedSiteState = await loadCachedSiteState();
    const puts = stubSiteStateCache();
    const waits: Promise<unknown>[] = [];
    const state = await cachedSiteState(ctx("https://x.test/", waits));
    await Promise.all(waits);
    expect(state).toEqual(fresh);
    expect(db.getSiteState).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
    expect(new URL(puts[0]!.url).searchParams.get("v")).toBe("7");
    expect(JSON.parse(puts[0]!.body)).toEqual(fresh);
    expect(puts[0]!.cacheControl).toBe("max-age=3600");
  });

  it("falls back to the database when the Cache API fails", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const fresh = { published: 3, sources: 1, topics: 2, inReview: 0, publicationVersion: "7" };
    db.getSiteState.mockResolvedValue(fresh);
    const cachedSiteState = await loadCachedSiteState();
    stubSiteStateCache({ fail: true });
    const state = await cachedSiteState(ctx("https://x.test/"));
    expect(state).toEqual(fresh);
    expect(db.getSiteState).toHaveBeenCalledTimes(1);
  });
});

describe("cachedTopics", () => {
  const topics = [
    { id: "db", label: "Databases", description: null, sortOrder: 0, count: 3 },
    { id: "ai", label: "AI", description: "Models", sortOrder: 1, count: 2 },
  ];

  it("returns the cached topics without querying D1 on a hit", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const cachedTopics = await loadCachedTopics();
    stubSiteStateCache({ hit: topics });
    const result = await cachedTopics(ctx("https://x.test/topics"));
    expect(result).toEqual(topics);
    expect(db.listTopics).not.toHaveBeenCalled();
  });

  it("stores the fresh topics under the publication version on a miss", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    db.listTopics.mockResolvedValue(topics);
    const cachedTopics = await loadCachedTopics();
    const puts = stubSiteStateCache();
    const waits: Promise<unknown>[] = [];
    const result = await cachedTopics(ctx("https://x.test/topics", waits));
    await Promise.all(waits);
    expect(result).toEqual(topics);
    expect(db.listTopics).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
    expect(new URL(puts[0]!.url).searchParams.get("v")).toBe("7");
    expect(JSON.parse(puts[0]!.body)).toEqual(topics);
    expect(puts[0]!.cacheControl).toBe("max-age=3600");
  });

  it("falls back to the database when the Cache API fails", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    db.listTopics.mockResolvedValue(topics);
    const cachedTopics = await loadCachedTopics();
    stubSiteStateCache({ fail: true });
    const result = await cachedTopics(ctx("https://x.test/topics"));
    expect(result).toEqual(topics);
    expect(db.listTopics).toHaveBeenCalledTimes(1);
  });
});

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

describe("cachePage article key", () => {
  async function loadFresh() {
    vi.resetModules();
    return (await import("../src/web/lib/cache")).cachePage;
  }

  it("keys article pages by slug and revision, unaffected by other publishes", async () => {
    db.getPublishedRevisionIdBySlug.mockResolvedValue("rev-1");
    db.getPublicationVersion.mockResolvedValue("7");
    db.getSiteState.mockResolvedValue({ published: 1, publicationVersion: "7" });
    const keys = stubCache();

    let cachePage = await load();
    await cachePage(ctx("https://x.test/articles/foo"), 60, () => new Response("a"), {
      articleSlug: "foo",
    });

    db.getPublicationVersion.mockResolvedValue("8");
    cachePage = await loadFresh();
    await cachePage(ctx("https://x.test/articles/foo"), 60, () => new Response("a"), {
      articleSlug: "foo",
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(new URL(keys[0]!).searchParams.get("__r")).toBe("rev-1");
    expect(new URL(keys[0]!).searchParams.has("__v")).toBe(false);

    db.getPublishedRevisionIdBySlug.mockResolvedValue("rev-2");
    cachePage = await loadFresh();
    await cachePage(ctx("https://x.test/articles/foo"), 60, () => new Response("a"), {
      articleSlug: "foo",
    });

    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
    expect(new URL(keys[2]!).searchParams.get("__r")).toBe("rev-2");
  });

  it("never reads or writes the cache for a slug without a published revision", async () => {
    db.getPublishedRevisionIdBySlug.mockResolvedValue(null);
    const matched: string[] = [];
    const written: string[] = [];
    const match = vi.fn(async (req: Request) => {
      matched.push(req.url);
      return undefined;
    });
    const put = vi.fn(async (req: Request) => {
      written.push(req.url);
    });
    vi.stubGlobal("caches", { default: { match, put } });
    const cachePage = await load();
    const render = vi.fn(() => new Response("missing", { status: 404 }));

    const response = await cachePage(ctx("https://x.test/articles/gone"), 60, render, {
      articleSlug: "gone",
    });

    expect(response.status).toBe(404);
    expect(render).toHaveBeenCalledTimes(1);
    expect(matched.filter((url) => url.includes("/articles/gone"))).toHaveLength(0);
    expect(written.filter((url) => url.includes("/articles/gone"))).toHaveLength(0);
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

  it("skips site counts for routes that do not render the layout", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    const cachePage = await load();
    stubCache(false);
    await cachePage(ctx("https://x.test/api/articles"), 60, () => new Response("{}"), { site: false });
    expect(db.getSiteState).not.toHaveBeenCalled();
  });

  it("renders with zero counts when site state cannot load", async () => {
    db.getPublicationVersion.mockResolvedValue("7");
    db.getSiteState.mockRejectedValue(new Error("d1 down"));
    const cachePage = await load();
    stubCache(false);
    const c = ctx("https://x.test/");
    await cachePage(c, 60, () => {
      expect(c.get("site")).toMatchObject({ published: 0, publicationVersion: "0" });
      return new Response("ok");
    });
  });

  it("does not share an in-flight version lookup across requests", async () => {
    const pending: Array<(value: string) => void> = [];
    db.getPublicationVersion.mockImplementation(() => new Promise<string>((r) => { pending.push(r); }));
    const cachePage = await load();
    stubCache(false);
    const first = cachePage(ctx("https://x.test/"), 60, () => new Response("a"));
    const second = cachePage(ctx("https://x.test/about"), 60, () => new Response("b"));
    await Promise.resolve();
    expect(db.getPublicationVersion).toHaveBeenCalledTimes(2);
    for (const resolve of pending) resolve("7");
    await Promise.allSettled([first, second]);
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
