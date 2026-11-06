import type { Explanation } from "./explanation";

/**
 * The pipeline records this reviewer string when it publishes without a human.
 * Keep the label in one place so the paid DTO cannot silently report automated
 * publications as reviewed by a person.
 */
export const AUTOMATED_REVIEWER = "Understory automated validation";

export const API_SCHEMA_VERSION = "1";
export const API_LICENSE = {
  name: "CC BY 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Based on Understory, licensed under CC BY 4.0.",
} as const;

export type ApiV1ReviewMode = "automated" | "human";

export type ApiV1Article = {
  id: string;
  slug: string;
  url: string;
  schema_version: string;
  revision_id: string;
  title: string;
  dek: string;
  one_sentence: string;
  tldr: string[];
  sections: unknown[];
  topic: string | null;
  source: { name: string; url: string };
  diagram: unknown;
  tradeoffs: unknown[];
  when_useful: string[];
  caveats: string[];
  reading_minutes: number;
  provenance: {
    model_id: string | null;
    prompt_version: string | null;
    schema_version: string | null;
    source_refs: string[];
  };
  sources: Array<{ id: string; label: string; url: string; note?: string }>;
  review: { mode: ApiV1ReviewMode; reviewer: string | null };
  source_published_at: string;
  generated_at: string;
  published_at: string;
  license: typeof API_LICENSE & { modified: false };
};

/**
 * Drops third-party material and internal provenance from a published
 * explanation. Quotation blocks reproduce publisher text and evidence IDs point
 * at stored snapshots, so neither may leave the paid API.
 */
export function sanitizeExplanation(explanation: Explanation) {
  const clean = JSON.parse(JSON.stringify(explanation)) as Explanation & {
    sources: Array<Record<string, unknown>>;
  };
  for (const source of clean.sources) delete source.evidenceIds;
  clean.sections = clean.sections.map((section) => ({
    ...section,
    blocks: section.blocks.filter((block) => block.type !== "quote"),
  }));
  clean.eli5 = {
    ...clean.eli5,
    body: clean.eli5.body.filter((block) => block.type !== "quote"),
  };
  return clean;
}

export type ApiArticleInput = {
  article: {
    id: string;
    slug: string;
    url: string;
    sourcePublishedAt: string;
    sourceName: string;
    sourceUrl: string;
    topicLabel: string | null;
  };
  revision: {
    id: string;
    createdAt: string;
    reviewedAt: string | null;
    reviewedBy: string | null;
    modelId: string | null;
    promptVersion: string | null;
    schemaVersion: string | null;
  };
  explanation: Explanation;
};

export function buildApiArticle(input: ApiArticleInput): ApiV1Article {
  const clean = sanitizeExplanation(input.explanation);
  const reviewer = input.revision.reviewedBy;
  return {
    id: input.article.id,
    slug: input.article.slug,
    url: input.article.url,
    schema_version: API_SCHEMA_VERSION,
    revision_id: input.revision.id,
    title: clean.contextHeadline,
    dek: clean.dek,
    one_sentence: clean.oneSentence,
    tldr: clean.tldr,
    sections: clean.sections,
    topic: input.article.topicLabel,
    source: { name: input.article.sourceName, url: input.article.sourceUrl },
    diagram: {
      kind: clean.diagram.kind,
      title: clean.diagram.title,
      text_alternative: clean.diagram.description,
      conceptual: clean.diagram.conceptual,
      nodes: clean.diagram.nodes,
      edges: clean.diagram.edges,
      ...(clean.diagram.caption ? { caption: clean.diagram.caption } : {}),
    },
    tradeoffs: clean.tradeoffs,
    when_useful: clean.whenUseful,
    caveats: clean.caveats,
    reading_minutes: clean.readingMinutes,
    provenance: {
      model_id: input.revision.modelId,
      prompt_version: input.revision.promptVersion,
      schema_version: input.revision.schemaVersion,
      source_refs: clean.sources.map((source) => source.id),
    },
    sources: clean.sources.map((source) => ({
      id: source.id,
      label: source.label,
      url: source.url,
      ...(source.note ? { note: source.note } : {}),
    })),
    review: {
      mode: reviewer === null || reviewer === AUTOMATED_REVIEWER ? "automated" : "human",
      reviewer: reviewer === null || reviewer === AUTOMATED_REVIEWER ? null : reviewer,
    },
    source_published_at: input.article.sourcePublishedAt,
    generated_at: input.revision.createdAt,
    published_at: input.revision.reviewedAt ?? input.revision.createdAt,
    license: { ...API_LICENSE, modified: false },
  };
}

export type ApiCursor = { publishedAt: string; id: string; topic: string };

export function encodeApiCursor(cursor: ApiCursor): string {
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Cursors are bound to the topic filter. Reusing a cursor under a different
 * filter would silently skip or repeat rows.
 */
export function decodeApiCursor(
  value: string | undefined | null,
  topic: string | null,
): ApiCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const cursor = parsed as Record<string, unknown>;
    if (typeof cursor.publishedAt !== "string" || typeof cursor.id !== "string") return null;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(cursor.publishedAt)) return null;
    if (cursor.id.length === 0 || cursor.id.length >= 80) return null;
    if ((cursor.topic ?? null) !== topic) return null;
    return { publishedAt: cursor.publishedAt, id: cursor.id, topic: topic ?? "" };
  } catch {
    return null;
  }
}
