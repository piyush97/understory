import type { ArticleWithSource } from "../../domain/article";

export type BookmarkRecord = {
  slug: string;
  headline: string;
  originalTitle: string;
  sourceName: string;
  publishedAt: string;
  readingMinutes: number | null;
  topicLabel: string | null;
};

export function bookmarkRecord(article: ArticleWithSource): BookmarkRecord {
  return {
    slug: article.slug,
    headline: article.contextHeadline ?? article.originalTitle,
    originalTitle: article.originalTitle,
    sourceName: article.sourceName,
    publishedAt: article.publishedAt,
    readingMinutes: article.readingMinutes,
    topicLabel: article.topicLabel,
  };
}

export function bookmarkJson(article: ArticleWithSource): string {
  return JSON.stringify(bookmarkRecord(article));
}
