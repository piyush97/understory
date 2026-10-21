import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { getPublicationVersion, getSiteState } from "../../infrastructure/db";

const VERSION_TTL_MS = 30_000;
let versionMemo: { value: string; at: number } | null = null;
let versionInFlight: Promise<string> | null = null;

async function publicationVersion(c: Context<AppEnv>): Promise<string> {
  if (versionMemo && Date.now() - versionMemo.at < VERSION_TTL_MS) return versionMemo.value;

  versionInFlight ??= getPublicationVersion(c.env.DB)
    .then((value) => {
      versionMemo = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      versionInFlight = null;
    });
  return versionInFlight;
}

export async function cachePage(
  c: Context<AppEnv>,
  ttlSeconds: number,
  render: () => Response | Promise<Response>,
): Promise<Response> {
  if (c.env.ENVIRONMENT !== "production") return render();

  let key: Request;
  let version: string;
  try {
    version = await publicationVersion(c);
  } catch {
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
    return render();
  }

  try {
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) return hit;

    try {
      c.set("site", await getSiteState(c.env.DB));
    } catch {
      // Fall through: an error page renders without counts.
    }
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
    return render();
  }
}
