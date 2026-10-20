import { z } from "zod";

export const sourceBlockSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(["heading", "paragraph", "list", "code", "caption", "quote"]),
  text: z.string().min(1).max(12_000),
  sourceUrl: z.string().url(),
  headingPath: z.array(z.string().max(160)).max(6).default([]),
});

export type SourceBlock = z.infer<typeof sourceBlockSchema>;

export const sourceSnapshotSchema = z.object({
  articleId: z.string().min(1),
  title: z.string().min(1).max(400),
  url: z.string().url(),
  fetchedAt: z.string().datetime(),
  extractorVersion: z.string().min(1).max(40),
  blocks: z.array(sourceBlockSchema).min(1).max(240),
  wordCount: z.number().int().min(1).max(60_000),
});

export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

export const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "source",
  "campaign",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "utm_id",
  "utm_name",
  "utm_reader",
  "utm_social",
  "utm_social-type",
]);

/**
 * Canonical identity for a discovered article. This is deliberately conservative:
 * unknown query parameters are preserved, because some publishers use them as
 * article identifiers.
 */
export function canonicalizeUrl(raw: string, base?: string): string {
  const url = new URL(raw, base);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http(s) URLs can be canonicalized");
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  const kept: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.push([key, value]);
  });
  kept.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));

  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

export function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
}

export function articleIdFromUrl(canonicalUrl: string): Promise<string> {
  return sha256Hex(canonicalUrl).then((hash) => `art_${hash.slice(0, 24)}`);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function slugify(value: string, maxLength = 72): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!slug) return "untitled";
  if (slug.length <= maxLength) return slug;
  return slug.slice(0, maxLength).replace(/-+[^-]*$/, "");
}

export function estimateReadingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 230));
}
