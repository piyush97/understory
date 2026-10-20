/** Destination checks cannot prevent DNS rebinding; enforce public egress at the platform too. */
export function publicHttpUrl(value: string | URL): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) throw new Error("Unsafe public URL");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    // Only native global-unicast IPv6; exclude translation/tunnel/documentation ranges.
    const address = host.slice(1, -1);
    const first = Number.parseInt(address.split(":")[0] ?? "", 16);
    const second = Number.parseInt(address.split(":")[1] || "0", 16);
    if (!(first >= 0x2000 && first < 0x3ffe) || first === 0x2002 || (first === 0x2001 && (second <= 0x1ff || second === 0xdb8))) throw new Error("Non-public IP destination");
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a = 0, b = 0, c = 0] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        // 192.0.0.0/24 (protocol assignments), plus RFC 5737 documentation /24s.
        (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) throw new Error("Non-public IP destination");
  } else if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || host.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-")) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) || host === "home.arpa" || host.endsWith(".home.arpa")) {
    throw new Error("Non-public hostname");
  }
  url.hash = "";
  return url;
}

export type PublicFetchOptions = {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: HeadersInit;
  acceptContentType?: (contentType: string) => boolean;
};

/** Read the complete response or fail: never silently truncate, including the final chunk. */
export async function fetchPublicText(value: string | URL, options: PublicFetchOptions): Promise<{
  text: string; url: string; contentType: string; status: number;
}> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new Error("Invalid fetch limits");
  let url = publicHttpUrl(value);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Public fetch timeout"));
      cancel();
    }, timeoutMs);
  });
  const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadline]);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await bounded(fetch(url.toString(), { headers: options.headers, redirect: "manual", signal: controller.signal }));
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (response.body) void response.body.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location || redirects >= maxRedirects) throw new Error("Public fetch redirect limit or missing location");
        url = publicHttpUrl(new URL(location, url));
        continue;
      }
      if (!response.ok) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new Error(`Public fetch responded ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      const length = response.headers.get("content-length");
      if ((length !== null && (!/^\d+$/.test(length) || Number(length) > options.maxBytes)) || (options.acceptContentType && !options.acceptContentType(contentType))) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new Error("Response too large or unexpected content type");
      }
      if (!response.body || typeof response.body.getReader !== "function") throw new Error("Response has no bounded stream reader");
      reader = response.body.getReader();
      let size = 0;
      const bytes = new Uint8Array(options.maxBytes);
      while (true) {
        const { done, value: chunk } = await bounded(reader.read());
        if (done) break;
        if (chunk) {
          size += chunk.byteLength;
          if (size > options.maxBytes) throw new Error("Response exceeds byte limit");
          bytes.set(chunk, size - chunk.byteLength);
        }
      }
      return { text: new TextDecoder().decode(bytes.subarray(0, size)), url: url.toString(), contentType, status: response.status };
    }
  } catch (error) {
    controller.abort();
    cancel();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
