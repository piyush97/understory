import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import {
  getPublishedRevisionIdBySlug,
  getPublicationVersion,
  getSiteState,
  listTopics,
  type SiteState,
} from "../../infrastructure/db";

const VERSION_TTL_MS = 30_000;
const SITE_STATE_KEY = "https://site-state.internal/v1";
const TOPICS_KEY = "https://topics.internal/v1";
export const ARTICLE_CACHE_SECONDS = 6 * 60 * 60;
// Workers must not share I/O promises across requests, so only the resolved
// value is memoized.
let versionMemo: { value: string; at: number } | null = null;

async function publicationVersion(c: Context<AppEnv>): Promise<string> {
  if (versionMemo && Date.now() - versionMemo.at < VERSION_TTL_MS) return versionMemo.value;
  const value = await getPublicationVersion(c.env.DB);
  versionMemo = { value, at: Date.now() };
  return value;
}

function freshSiteState(c: Context<AppEnv>): Promise<SiteState> {
  // 30s of count staleness is invisible to readers and keeps scanner traffic
  // (404s, junk filters) from re-running the COUNT scans on every request.
  return getSiteState(c.env.DB, { maxAgeMs: 30_000 });
}

async function cachedJson<T>(
  c: Context<AppEnv>,
  keyBase: string,
  load: () => Promise<T>,
): Promise<T> {
  if (c.env.ENVIRONMENT !== "production" || typeof caches === "undefined") {
    return load();
  }

  let key: Request | null = null;
  try {
    const version = await publicationVersion(c);
    key = new Request(`${keyBase}?v=${encodeURIComponent(version)}`, { method: "GET" });
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as T;
  } catch {
    // Cache reads are best effort; fall through to a fresh D1 read.
  }

  const value = await load();

  if (key) {
    try {
      const cache = (caches as unknown as { default: Cache }).default;
      const put = cache
        .put(
          key,
          new Response(JSON.stringify(value), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "max-age=3600",
            },
          }),
        )
        .catch(() => {});
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put;
      }
    } catch {
      // A failed write must not fail the request; the value is still returned.
    }
  }

  return value;
}

export async function cachedSiteState(c: Context<AppEnv>): Promise<SiteState> {
  const existing = c.get("site");
  if (existing) return existing;
  return cachedJson(c, SITE_STATE_KEY, () => freshSiteState(c));
}

export type CachedTopic = Awaited<ReturnType<typeof listTopics>>[number];

export async function cachedTopics(c: Context<AppEnv>): Promise<CachedTopic[]> {
  return cachedJson(c, TOPICS_KEY, () => listTopics(c.env.DB));
}

async function loadSite(c: Context<AppEnv>, enabled: boolean): Promise<void> {
  if (!enabled || c.get("site")) return;
  try {
    c.set("site", await cachedSiteState(c));
  } catch {
    c.set("site", { published: 0, sources: 0, topics: 0, inReview: 0, publicationVersion: "0" });
  }
}

function baseKeyUrl(c: Context<AppEnv>): URL {
  const url = new URL(c.req.url);
  const keyUrl = new URL(url.pathname, url.origin);
  for (const name of ["topic", "cursor", "limit"]) {
    const value = url.searchParams.get(name);
    if (value !== null) keyUrl.searchParams.set(name, value);
  }
  return keyUrl;
}

export async function cachePage(
  c: Context<AppEnv>,
  ttlSeconds: number,
  render: () => Response | Promise<Response>,
  options: { site?: boolean; articleSlug?: string } = {},
): Promise<Response> {
  const withSite = options.site !== false;
  if (c.env.ENVIRONMENT !== "production") {
    await loadSite(c, withSite);
    return render();
  }

  let key: Request;
  if (options.articleSlug) {
    let revisionId: string | null;
    try {
      revisionId = await getPublishedRevisionIdBySlug(c.env.DB, options.articleSlug);
    } catch {
      await loadSite(c, withSite);
      return render();
    }
    if (!revisionId) {
      // Missing or unpublished slugs must 404 without reading or writing a
      // cache entry, so a stale page can never outlive an unpublish.
      await loadSite(c, withSite);
      return render();
    }
    try {
      const keyUrl = baseKeyUrl(c);
      keyUrl.searchParams.set("__r", revisionId);
      key = new Request(keyUrl.toString(), { method: "GET" });
    } catch {
      await loadSite(c, withSite);
      return render();
    }
  } else {
    let version: string;
    try {
      version = await publicationVersion(c);
    } catch {
      await loadSite(c, withSite);
      return render();
    }

    try {
      const keyUrl = baseKeyUrl(c);
      keyUrl.searchParams.set("__v", version);
      key = new Request(keyUrl.toString(), { method: "GET" });
    } catch {
      await loadSite(c, withSite);
      return render();
    }
  }

  try {
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) return hit;

    await loadSite(c, withSite);
    const response = await render();
    if (response.status !== 200) return response;

    const headers = new Headers(response.headers);
    headers.set(
      "Cache-Control",
      `public, max-age=0, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`,
    );
    const cacheable = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });

    try {
      c.executionCtx.waitUntil(cache.put(key, cacheable.clone()));
    } catch {
      // The test harness and some local runtimes do not expose an execution context.
    }
    return cacheable;
  } catch {
    await loadSite(c, withSite);
    return render();
  }
}
