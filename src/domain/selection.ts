import type { SourceBlock } from "./source";

export type SelectionInput = {
  title: string;
  url: string;
  blocks: SourceBlock[];
  wordCount: number;
};

export type SelectionDecision = {
  score: number;
  decision: "generate" | "skip";
  reasons: string[];
  signals: Record<string, number>;
};

export type UrlKind = "article" | "docs" | "archive" | "release" | "podcast";

export const SELECTION_MIN_SCORE = 45;
export const SELECTION_DUPLICATE_WINDOW_DAYS = 14;
export const LEAD_WINDOW_DAYS = 14;

export const MECHANISM_TERMS = [
  "design", "architecture", "internals", "implementation", "mechanism",
  "pipeline", "protocol", "scheduler", "cache", "index", "migration",
  "consensus", "sharding", "query planner", "runtime", "compiler",
  "storage engine", "consistency", "concurrency", "latency", "throughput",
  "failure", "retry", "backpressure", "partitioning", "replication",
  "coordination", "serialization", "garbage collection", "transaction",
  "lock", "queue",
] as const;

// Title-only mechanism words for the release-note exception. Keep "how" and
// similar words out of MECHANISM_TERMS so they do not count as body evidence.
export const TITLE_MECHANISM_TERMS: readonly string[] = [
  ...MECHANISM_TERMS, "how", "inside", "scaling", "debugging", "lessons",
];

export const PROMOTIONAL_PHRASES = [
  "we are excited", "best-in-class", "world-class", "industry-leading",
  "cutting-edge", "revolutionary", "game-changing", "seamless", "unlock",
  "empower", "trusted by",
] as const;

export const RELEASE_TITLE_PATTERN =
  /\b(release[sd]?|releasing|changelog|what'?s new|now available|general availability|ga|beta|preview|launch(?:ed|es)?|announc(?:e|ed|ing)|introduc(?:e|ed|ing)|unveil(?:ed)?|ships?|rolled out|podcast|episode|webinar|roundup|weekly|newsletter|forrester|gartner|award|recognized|strong performer)\b/i;

const METRIC_PATTERN =
  /(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|hours?|days?|kb|mb|gb|tb|pb|req\/s|rps|qps|million|billion)|\$\s?\d|€\s?\d)/gi;

const TITLE_STOPWORDS = new Set([
  "introducing", "announcing", "now", "available", "new", "update", "release",
  "general", "beta", "the", "a", "an", "on", "in", "for", "with", "via", "to",
  "of", "and", "is", "are", "we", "our", "how", "what", "why",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) =>
    new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text),
  );
}

function countMechanismTerms(text: string, terms: readonly string[]): number {
  let count = 0;
  for (const term of terms) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text)) count += 1;
  }
  return count;
}

function countOccurrences(text: string, phrase: string): number {
  return text.match(new RegExp(escapeRegExp(phrase), "gi"))?.length ?? 0;
}

export function classifyUrl(url: string): UrlKind {
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // Keep the raw string for malformed URLs.
  }
  if (/\/(docs|documentation|reference|manual)(\/|$)/.test(pathname)) return "docs";
  if (/\/(tags?|categories?|archive)(\/|$)/.test(pathname)) return "archive";
  if (/\/(changelog|release-notes|releases|announcements)(\/|$)/.test(pathname)) return "release";
  if (/\/(podcast|podcasts|episodes?|webinars?)(\/|$)/.test(pathname)) return "podcast";
  return "article";
}

export function scoreSource(input: SelectionInput): SelectionDecision {
  const { title, url, blocks, wordCount } = input;

  const codeCount = blocks.filter((block) => block.kind === "code").length;
  const headingCount = blocks.filter((block) => block.kind === "heading").length;
  const headingText = blocks
    .filter((block) => block.kind === "heading")
    .map((block) => block.text)
    .join(" ");
  const allText = blocks.map((block) => block.text).join(" ");

  const metricCount = allText.match(METRIC_PATTERN)?.length ?? 0;
  const mechanismHeadingCount = countMechanismTerms(
    `${title} ${headingText}`,
    MECHANISM_TERMS,
  );
  const mechanismCountAll = countMechanismTerms(`${title} ${allText}`, MECHANISM_TERMS);
  const promotionalCount = PROMOTIONAL_PHRASES.reduce(
    (total, phrase) => total + countOccurrences(allText, phrase),
    0,
  );
  const promotionalDensity = (promotionalCount / Math.max(wordCount, 1)) * 1000;

  const urlKind = classifyUrl(url);
  const titleHasMechanism = hasAnyTerm(title, MECHANISM_TERMS);

  let score = 50;
  const reasons: string[] = [];

  // Negative signals, in rubric order.
  if (RELEASE_TITLE_PATTERN.test(title)) {
    const penalty = hasAnyTerm(title, TITLE_MECHANISM_TERMS) ? 15 : 30;
    score -= penalty;
    reasons.push(`release/announcement title (-${penalty})`);
  }

  if (urlKind === "docs") {
    score -= 30;
    reasons.push("docs/reference URL (-30)");
  } else if (urlKind === "archive") {
    score -= 25;
    reasons.push("archive/tag URL (-25)");
  } else if (urlKind === "release" || urlKind === "podcast") {
    score -= 20;
    reasons.push(`${urlKind} URL (-20)`);
  }

  if (promotionalDensity >= 3) {
    score -= 20;
    reasons.push("promotional language (-20)");
  }

  if (wordCount < 500) {
    score -= 15;
    reasons.push(`${wordCount} words (-15)`);
  }

  if (codeCount === 0 && metricCount === 0 && mechanismCountAll === 0) {
    score -= 15;
    reasons.push("no code, metrics, or mechanism terms (-15)");
  }

  // Positive signals.
  if (wordCount >= 1500) {
    score += 15;
    reasons.push(`${wordCount} words (+15)`);
  } else if (wordCount >= 800) {
    score += 10;
    reasons.push(`${wordCount} words (+10)`);
  }

  if (codeCount >= 3) {
    score += 15;
    reasons.push(`${codeCount} code blocks (+15)`);
  } else if (codeCount >= 1) {
    score += 10;
    reasons.push(`${codeCount} code block(s) (+10)`);
  }

  if (metricCount >= 3) {
    score += 10;
    reasons.push(`${metricCount} metrics (+10)`);
  }

  if (mechanismHeadingCount >= 2) {
    score += 10;
    reasons.push(`${mechanismHeadingCount} mechanism terms (+10)`);
  }

  if (headingCount >= 3) {
    score += 5;
    reasons.push(`${headingCount} headings (+5)`);
  }

  if (blocks.length >= 10) {
    score += 5;
    reasons.push(`${blocks.length} blocks (+5)`);
  }

  const clamped = Math.min(100, Math.max(0, score));

  const forcedSkip = (urlKind === "docs" || urlKind === "archive") && !titleHasMechanism;
  if (forcedSkip) {
    reasons.unshift(urlKind === "docs" ? "docs/reference URL" : "archive/tag URL");
  }

  return {
    score: clamped,
    decision: forcedSkip || clamped < SELECTION_MIN_SCORE ? "skip" : "generate",
    reasons,
    signals: {
      wordCount,
      codeCount,
      headingCount,
      metricCount,
      mechanismHeadingCount,
      mechanismCountAll,
      promotionalCount,
      promotionalDensity,
      forcedSkip: forcedSkip ? 1 : 0,
    },
  };
}

export function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !TITLE_STOPWORDS.has(token))
    .filter((token) => !/^v?\d+(?:\.\d+)*$/.test(token));
}

export function isNearDuplicate(a: string, b: string): boolean {
  const left = new Set(normalizeTitle(a));
  const right = new Set(normalizeTitle(b));
  if (left.size === 0 || right.size === 0) return false;

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }

  if (shared >= 3 && shared / Math.min(left.size, right.size) >= 0.8) return true;
  if (shared >= 4 && shared / (left.size + right.size - shared) >= 0.6) return true;
  return false;
}

export type DuplicateCandidate = {
  id: string;
  originalTitle: string;
  slug: string;
  publishedAt: string;
};

export function findDuplicate(
  title: string,
  candidates: DuplicateCandidate[],
): DuplicateCandidate | null {
  const sorted = [...candidates].sort((a, b) => {
    const aTime = Date.parse(a.publishedAt);
    const bTime = Date.parse(b.publishedAt);
    const aValue = Number.isNaN(aTime) ? 0 : aTime;
    const bValue = Number.isNaN(bTime) ? 0 : bTime;
    if (aValue !== bValue) return aValue - bValue;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });

  for (const candidate of sorted) {
    if (isNearDuplicate(title, candidate.originalTitle)) return candidate;
  }
  return null;
}

export function duplicateWindowStart(
  publishedAt: string,
  windowDays: number = SELECTION_DUPLICATE_WINDOW_DAYS,
): string {
  const parsed = Date.parse(publishedAt);
  const base = Number.isNaN(parsed) ? Date.now() : parsed;
  return new Date(base - windowDays * 86_400_000).toISOString();
}

export function formatSelectionReason(reasons: string[]): string {
  return reasons.slice(0, 3).join("; ").slice(0, 500);
}
