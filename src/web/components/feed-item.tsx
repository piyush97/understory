import type { ArticleWithSource } from "../../domain/article";
import { formatDate, plural } from "../lib/format";
import { bookmarkJson } from "../lib/bookmark";
import { IconArrowUpRight, IconBookmark } from "./icons";

type FeedItemProps = {
  article: ArticleWithSource;
  index: number;
  pending?: boolean;
};

const PENDING_LABEL: Record<string, string> = {
  discovered: "Queued",
  extracting: "Reading source",
  generating: "Drafting",
  review: "In review",
  failed: "Paused",
};

export function FeedItem({ article, index, pending = false }: FeedItemProps) {
  const rank = String(index).padStart(2, "0");
  const headline = article.contextHeadline ?? article.originalTitle;
  const dek = article.dek ?? article.summary ?? "";
  const status = PENDING_LABEL[article.status] ?? "Queued";

  return (
    <article class={pending ? "feed-item feed-item--pending" : "feed-item"}>
      <div class="feed-item__rank" aria-hidden="true">
        {rank}
      </div>
      <div class="feed-item__body">
        <div class="feed-item__topline">
          {pending ? (
            <span class="status-tag">
              <span class="status-tag__dot" aria-hidden="true" />
              {status}
            </span>
          ) : (
            <span class="topic-tag">{article.topicLabel ?? "Engineering"}</span>
          )}
          <span class="feed-item__topline-rule" aria-hidden="true" />
          <span class="feed-item__source">{article.sourceName}</span>
        </div>

        <h3 class="feed-item__headline">
          {pending ? (
            headline
          ) : (
            <a href={`/articles/${article.slug}`}>{headline}</a>
          )}
        </h3>

        {dek ? <p class="feed-item__dek">{dek}</p> : null}

        <p class="feed-item__origin">
          <span class="feed-item__origin-label">Original</span>{" "}
          <a href={article.canonicalUrl} rel="noopener">
            {article.originalTitle}
          </a>
        </p>

        <div class="feed-item__meta">
          <span>{formatDate(article.publishedAt)}</span>
          {article.readingMinutes ? (
            <>
              <span class="sep">/</span>
              <span>{plural(article.readingMinutes, "minute")} read</span>
            </>
          ) : null}
          {pending ? null : (
            <>
              <span class="sep">/</span>
              <a class="feed-item__original-link" href={article.canonicalUrl} rel="noopener">
                Read original <IconArrowUpRight size={11} />
              </a>
            </>
          )}
          <span class="feed-item__meta-spacer" />
          {pending ? null : (
            <button
              type="button"
              class="save-button js-only"
              data-bookmark={bookmarkJson(article)}
              aria-pressed="false"
              aria-label={`Save ${headline}`}
            >
              <IconBookmark size={14} />
              <span class="save-button__label">Save</span>
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
