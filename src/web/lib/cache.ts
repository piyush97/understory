import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { getPublicationVersion, getSiteState, type SiteState } from "../../infrastructure/db";

const VERSION_TTL_MS = 30_000;
const SITE_STATE_KEY = "https://site-state.internal/v1";
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

export async function cachedSiteState(c: Context<AppEnv>): Promise<SiteState> {
  const existing = c.get("site");
  if (existing) return existing;

  if (c.env.ENVIRONMENT !== "production" || typeof caches === "undefined") {
    return freshSiteState(c);
  }

  let key: Request | null = null;
  try {
    const version = await publicationVersion(c);
    key = new Request(`${SITE_STATE_KEY}?v=${encodeURIComponent(version)}`, { method: "GET" });
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as SiteState;
  } catch {
    // Cache reads are best effort; fall through to a fresh D1 read.
  }

  const state = await freshSiteState(c);

  if (key) {
    try {
      const cache = (caches as unknown as { default: Cache }).default;
      const put = cache
        .put(
          key,
          new Response(JSON.stringify(state), {
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
      // A failed write must not fail the request; the state is still returned.
    }
  }

  return state;
}

async function loadSite(c: Context<AppEnv>, enabled: boolean): Promise<void> {
  if (!enabled || c.get("site")) return;
  try {
    c.set("site", await cachedSiteState(c));
  } catch {
    c.set("site", { published: 0, sources: 0, topics: 0, inReview: 0, publicationVersion: "0" });
  }
}

export async function cachePage(
  c: Context<AppEnv>,
  ttlSeconds: number,
  render: () => Response | Promise<Response>,
  options: { site?: boolean } = {},
): Promise<Response> {
  const withSite = options.site !== false;
  if (c.env.ENVIRONMENT !== "production") {
    await loadSite(c, withSite);
    return render();
  }

  let key: Request;
  let version: string;
  try {
    version = await publicationVersion(c);
  } catch {
    await loadSite(c, withSite);
    return render();
  }

  try {
    const url = new URL(c.req.url);
    const keyUrl = new URL(url.pathname, url.origin);
    for (const name of ["topic", "cursor", "limit"]) {
      const value = url.searchParams.get(name);
      if (value !== null) keyUrl.searchParams.set(name, value);
    }
    keyUrl.searchParams.set("__v", version);
    key = new Request(keyUrl.toString(), { method: "GET" });
  } catch {
    await loadSite(c, withSite);
    return render();
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
