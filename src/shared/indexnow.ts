// IndexNow tells Bing, Yandex, and partners a URL changed:
// https://www.indexnow.org/documentation. Best effort: never throws.
export async function pingIndexNow(
  env: { SITE_URL: string; INDEXNOW_KEY?: string; ENVIRONMENT?: string },
  paths: string[],
): Promise<boolean> {
  const key = env.INDEXNOW_KEY;
  if (!key || paths.length === 0 || env.ENVIRONMENT !== "production") return false;
  const site = new URL(env.SITE_URL);
  const urlList = paths.map((path) => new URL(path, site).toString());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: site.host, key, keyLocation: new URL(`/${key}.txt`, site).toString(), urlList }),
      signal: controller.signal,
    });
    return response.ok;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "indexnow_failed", message: error instanceof Error ? error.message : String(error) }));
    return false;
  } finally {
    clearTimeout(timer);
  }
}
