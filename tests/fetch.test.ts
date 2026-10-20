import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchArticlePage } from "../src/pipeline/extract";
import { fetchPublicText, publicHttpUrl } from "../src/shared/fetch";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const unsafe = [
  "file:///etc/passwd", "http://localhost/", "http://sub.localhost/", "http://metadata.google.internal/", "http://printer.local/", "http://intranet/",
  "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/", "http://169.254.169.254/", "http://100.64.0.1/", "http://0.0.0.0/",
  "http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a00:1]/", "http://[2002:7f00:1::]/", "http://[2001:db8::1]/", "http://[64:ff9b::a00:1]/",
  "http://user:secret@example.com/", "https://example.com:8080/",
];
describe("public fetch boundaries", () => {
  it.each([
    "192.0.78.24", "203.0.178.191", "198.51.99.1",
    "192.0.1.255", "192.0.3.0", "198.51.99.255", "198.51.101.0", "203.0.112.255", "203.0.114.0",
  ])("allows public IPv4 adjacent to special-use ranges: %s", (ip) => {
    expect(publicHttpUrl(`https://${ip}/`).hostname).toBe(ip);
  });
  it.each([
    "192.0.0.1", "192.0.0.255", "192.0.2.0", "192.0.2.255", "198.51.100.0", "198.51.100.255", "203.0.113.0", "203.0.113.255",
    "198.18.0.0", "198.19.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1",
  ])("blocks special-use IPv4: %s", (ip) => {
    expect(() => publicHttpUrl(`https://${ip}/`)).toThrow(/Non-public/);
  });
  it.each(["https://example.com", "http://example.com", "https://8.8.8.8", "https://[2001:4860:4860::8888]"])("accepts public destination %s", (url) => {
    expect(publicHttpUrl(url).protocol).toMatch(/^https?:$/);
  });
  it("enforces byte limits across the final multibyte chunk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("世界")));
    await expect(fetchPublicText("https://example.com", { maxBytes: 5 })).rejects.toThrow(/limit/i);
  });
  it("checks declared size before reading and cancels the body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": "1000" } })));
    await expect(fetchPublicText("https://example.com", { maxBytes: 10 })).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });
  it("times out a fetch even when the mock transport ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => { signal = init.signal; return new Promise(() => {}); }));
    const result = expect(fetchPublicText("https://example.com", { maxBytes: 100, timeoutMs: 50 })).rejects.toThrow(/time|abort/i);
    await vi.advanceTimersByTimeAsync(51); await result;
    expect(signal?.aborted).toBe(true);
  });
  it.each(unsafe)("blocks unsafe initial URL %s before fetching", async (url) => {
    const fetch = vi.fn(async () => new Response("ok", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchArticlePage(url, "test")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(unsafe)("blocks unsafe redirect %s", async (location) => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchArticlePage("https://example.com", "test")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("caps the final chunk rather than accepting an oversized article", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(7_999_999)); c.enqueue(new Uint8Array(2)); }, cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": "text/html" } })));
    await expect(fetchArticlePage("https://example.com", "test")).rejects.toThrow(/large|limit/i);
    expect(cancel).toHaveBeenCalled();
  });
  it("does not use unbounded text() when a reader is unavailable", async () => {
    const text = vi.fn(async () => "x".repeat(8_000_001));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), body: null, text })));
    await expect(fetchArticlePage("https://example.com", "test")).rejects.toThrow();
    expect(text).not.toHaveBeenCalled();
  });
  it("does not fall back to text() when body.getReader is missing", async () => {
    const text = vi.fn(async () => "unbounded");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: {}, text })));
    await expect(fetchPublicText("https://example.com", { maxBytes: 100 })).rejects.toThrow(/reader/i);
    expect(text).not.toHaveBeenCalled();
  });
  it("cancels a stalled body at the deadline even if the reader ignores abort", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { signal = init.signal; return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel }), { headers: { "content-type": "text/html" } }); }));
    const result = expect(fetchArticlePage("https://example.com", "test")).rejects.toThrow(/time|abort/i);
    await vi.advanceTimersByTimeAsync(20_001);
    await result;
    expect(signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalled();
  });
  it("follows bounded relative redirects and accepts public HTTP(S) without content length", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/article" } })).mockResolvedValueOnce(new Response("hello 世界", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchArticlePage("https://example.com/start", "test")).resolves.toMatchObject({ html: "hello 世界", finalUrl: "https://example.com/article" });
    expect(fetch.mock.calls.every(([, options]) => options.redirect === "manual")).toBe(true);
  });
  it("rejects redirect loops within six requests", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchArticlePage("https://example.com", "test")).rejects.toThrow();
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
