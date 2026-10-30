export const ARTICLE_STATUSES = [
  "discovered",
  "extracting",
  "generating",
  "review",
  "published",
  "failed",
  "skipped",
] as const;

export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export type Article = {
  id: string;
  sourceId: string;
  canonicalUrl: string;
  originalTitle: string;
  publishedAt: string;
  discoveredAt: string;
  author: string | null;
  summary: string | null;
  slug: string;
  status: ArticleStatus;
  contextHeadline: string | null;
  dek: string | null;
  topicId: string | null;
  readingMinutes: number | null;
  publishedRevisionId: string | null;
  lastError: string | null;
  selectionScore: number;
  selectionReason: string | null;
  duplicateOf: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArticleWithSource = Article & {
  sourceName: string;
  sourceSiteUrl: string;
  sourceHost: string;
  topicLabel: string | null;
};

export type PublishedArticle = ArticleWithSource & {
  revisionId: string;
  revisionContent: string;
  revisionProvenance: string;
};

export type Topic = {
  id: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

export type SourceRow = {
  id: string;
  name: string;
  siteUrl: string;
  feedUrl: string | null;
  host: string;
  status: "active" | "paused";
};

export type RevisionRow = {
  id: string;
  articleId: string;
  snapshotId: string;
  status: "draft" | "approved" | "published" | "rejected";
  contentJson: string;
  provenanceJson: string;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
};

export type JobKind = "extract" | "generate" | "discover";
export type JobState = "pending" | "running" | "done" | "failed" | "deferred";

export type Job = {
  id: string;
  kind: JobKind;
  articleId: string | null;
  payloadJson: string;
  state: JobState;
  attempts: number;
  idempotencyKey: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  nextRunAt: string;
  lastError: string | null;
};
