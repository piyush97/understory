export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export function excerpt(value: string, max = 180): string {
  const clean = stripTags(value);
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 1);
  const boundary = slice.lastIndexOf(" ");
  return `${(boundary > 40 ? slice.slice(0, boundary) : slice).trim()}…`;
}
