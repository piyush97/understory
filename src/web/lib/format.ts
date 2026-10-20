const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const shortFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const stampFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatDate(value: string): string {
  return dayFormat.format(new Date(value));
}

export function formatShortDate(value: string): string {
  return shortFormat.format(new Date(value));
}

export function formatStamp(value: string): string {
  return `${stampFormat.format(new Date(value))} UTC`;
}

export function relativeDate(value: string, now = new Date()): string {
  const then = new Date(value).getTime();
  const diff = now.getTime() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatShortDate(value);
}

export function issueNumber(version: string): string {
  const parsed = Number.parseInt(version, 10);
  return String(Number.isFinite(parsed) ? parsed : 1).padStart(3, "0");
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function absoluteUrl(siteUrl: string, path: string): string {
  return new URL(path, siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`).toString();
}
