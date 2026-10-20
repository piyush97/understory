import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";

export async function cachePage(
  c: Context<AppEnv>,
  ttlSeconds: number,
  render: () => Response | Promise<Response>,
): Promise<Response> {
  if (c.env.ENVIRONMENT !== "production") return render();

  let key: Request;
  try {
    const url = new URL(c.req.url);
    url.searchParams.set("__v", c.get("site").publicationVersion);
    key = new Request(url.toString(), { method: "GET" });
  } catch {
    return render();
  }

  try {
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) return hit;

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
