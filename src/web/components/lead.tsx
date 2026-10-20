import type { PublishedArticle } from "../../domain/article";
import type { Explanation } from "../../domain/explanation";
import { bookmarkJson } from "../lib/bookmark";
import { formatDate, plural } from "../lib/format";
import { DiagramPlate } from "./diagram";
import { IconArrowRight, IconBookmark } from "./icons";

type LeadStoryProps = {
  article: PublishedArticle;
  explanation: Explanation;
};

export function LeadStory({ article, explanation }: LeadStoryProps) {
  return (
    <section class="lead" aria-labelledby="lead-headline">
      <div class="lead__copy">
        <div class="lead__topline">
          <span class="lead__label">Lead explainer</span>
          <span class="lead__topic">{article.topicLabel ?? "Engineering"}</span>
        </div>
        <h2 class="lead__headline" id="lead-headline">
          <a href={`/articles/${article.slug}`}>{explanation.contextHeadline}</a>
        </h2>
        <p class="lead__dek">{explanation.dek}</p>
        <p class="lead__sentence">{explanation.oneSentence}</p>
        <div class="lead__meta">
          <span>{article.sourceName}</span>
          <span class="sep">/</span>
          <span>{formatDate(article.publishedAt)}</span>
          <span class="sep">/</span>
          <span>{plural(explanation.readingMinutes, "minute")} read</span>
          <button
            type="button"
            class="save-button js-only"
            data-bookmark={bookmarkJson(article)}
            aria-pressed="false"
            aria-label={`Save ${explanation.contextHeadline}`}
          >
            <IconBookmark size={14} />
            <span class="save-button__label">Save</span>
          </button>
        </div>
        <a class="text-link lead__cta" href={`/articles/${article.slug}`}>
          Read the explainer <IconArrowRight size={15} />
        </a>
      </div>
      <div class="lead__figure">
        <DiagramPlate diagram={explanation.diagram} figure="A" compact />
      </div>
    </section>
  );
}
