export type FeedCursor = {
  publishedAt: string;
  id: string;
};

export function encodeCursor(cursor: FeedCursor): string {
  const json = JSON.stringify(cursor);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(value: string | undefined | null): FeedCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "publishedAt" in parsed &&
      "id" in parsed &&
      typeof parsed.publishedAt === "string" &&
      typeof parsed.id === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(parsed.publishedAt) &&
      parsed.id.length > 0 &&
      parsed.id.length < 80
    ) {
      return { publishedAt: parsed.publishedAt, id: parsed.id };
    }
  } catch {
    // A malformed cursor falls back to the first page rather than erroring.
  }
  return null;
}
