import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import type { ArticleWithSource, PublishedArticle } from "../../domain/article";
import type { Explanation, Section, SourceRef } from "../../domain/explanation";
import { getPublishedArticleBySlug, getAdjacentArticles, listRelatedArticles } from "../../infrastructure/db";
import { Layout } from "../components/layout";
import { Blocks } from "../components/blocks";
import { DiagramPlate } from "../components/diagram";
import { bookmarkJson } from "../lib/bookmark";
import { parseExplanation, parseProvenance } from "../lib/content";
import { formatDate, plural } from "../lib/format";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUpRight,
  IconBookmark,
  IconLink,
} from "../components/icons";
import { renderNotFound } from "./not-found";

export async function renderArticle(c: Context<AppEnv>) {
  const slug = c.req.param("slug");
  if (!slug) return renderNotFound(c);

  const article = await getPublishedArticleBySlug(c.env.DB, slug);
  if (!article) return renderNotFound(c);

  const explanation = parseExplanation(article.revisionContent);
  if (!explanation) return renderNotFound(c);

  const provenance = parseProvenance(article.revisionProvenance);
  const [related, adjacent] = await Promise.all([
    listRelatedArticles(c.env.DB, article.id, article.topicId, 3),
    getAdjacentArticles(c.env.DB, article.publishedAt, article.id),
  ]);

  return c.render(
    <Layout
      title={explanation.contextHeadline}
      description={explanation.dek}
      path={`/articles/${article.slug}`}
      site={c.get("site")}
      siteUrl={c.env.SITE_URL}
      active={null}
      ogType="article"
      jsonLd={{
        "@context": "https://schema.org",
        "@type": "Article",
        headline: explanation.contextHeadline,
        description: explanation.dek,
        datePublished: article.publishedAt,
        author: { "@type": "Person", name: article.author ?? article.sourceName },
        publisher: { "@type": "Organization", name: "Understory" },
        isBasedOn: article.canonicalUrl,
        url: new URL(`/articles/${article.slug}`, c.env.SITE_URL).toString(),
      }}
    >
      <article class="article-page">
        <ArticleHeader article={article} explanation={explanation} />

        <div class="article-layout">
          <ContentsRail explanation={explanation} />

          <div class="article-main">
            <SummarySheet explanation={explanation} />

            {explanation.sections.map((section, index) => (
              <>
                <SectionView section={section} number={index + 1} />
                {index === 1 ? (
                  <DiagramPlate diagram={explanation.diagram} figure="1" />
                ) : null}
              </>
            ))}

            <TranslationPanel explanation={explanation} />
            <TradeoffPanel explanation={explanation} />
            <UsefulPanel explanation={explanation} />
            <SourcesPanel sources={explanation.sources} />
            <SheetRecord
              article={article}
              explanation={explanation}
              provenance={provenance}
            />
            <ArticleFooter adjacent={adjacent} />
          </div>

          <SheetRail article={article} explanation={explanation} />
        </div>

        {related.length > 0 ? (
          <RelatedStrip articles={related} />
        ) : null}
      </article>
    </Layout>,
  );
}

function ArticleHeader({
  article,
  explanation,
}: {
  article: PublishedArticle;
  explanation: Explanation;
}) {
  return (
    <header class="article-head">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a href="/">Index</a>
        <span aria-hidden="true">/</span>
        {article.topicId ? (
          <a href={`/?topic=${encodeURIComponent(article.topicId)}`}>
            {article.topicLabel ?? "Topic"}
          </a>
        ) : (
          <span>Engineering</span>
        )}
      </nav>

      <h1 class="article-head__title">{explanation.contextHeadline}</h1>
      <p class="article-head__dek">{explanation.dek}</p>

      <div class="article-head__byline">
        <span>
          <a
            class="byline-source"
            href={`/sources#source-${article.sourceId}`}
          >
            {article.sourceName}
          </a>
        </span>
        {article.author ? (
          <>
            <span class="sep">/</span>
            <span>{article.author}</span>
          </>
        ) : null}
        <span class="sep">/</span>
        <span>{formatDate(article.publishedAt)}</span>
        <span class="sep">/</span>
        <span>{plural(explanation.readingMinutes, "minute")} read</span>
      </div>

      <div class="article-actions">
        <a
          class="button button--solid"
          href={article.canonicalUrl}
          target="_blank"
          rel="noopener"
        >
          Read original <IconArrowUpRight size={12} />
        </a>
        <button
          type="button"
          class="button button--quiet save-button js-only"
          data-bookmark={bookmarkJson(article)}
          aria-pressed="false"
          aria-label={`Save ${explanation.contextHeadline}`}
        >
          <IconBookmark size={14} />
          <span class="save-button__label">Save</span>
        </button>
        <button
          type="button"
          class="button button--quiet copy-button js-only"
          data-copy-link
          aria-label="Copy a link to this explainer"
        >
          <IconLink size={14} />
          <span>Copy link</span>
        </button>
      </div>
    </header>
  );
}

function ContentsRail({ explanation }: { explanation: Explanation }) {
  const items = [
    { href: "#summary", label: "Summary", number: "00" },
    ...explanation.sections.map((section, index) => ({
      href: `#${section.id}`,
      label: section.title,
      number: String(index + 1).padStart(2, "0"),
    })),
    { href: "#eli5", label: "The short version", number: "E" },
    { href: "#tradeoffs", label: "Trade-offs", number: "T" },
    { href: "#sources", label: "Sources", number: "S" },
  ];

  return (
    <aside class="contents-rail" aria-label="Contents">
      <p class="rail-label">Contents</p>
      <ol class="contents-list">
        {items.map((item) => (
          <li>
            <a href={item.href}>
              <span class="contents-list__num">{item.number}</span>
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ol>
      <a class="contents-rail__top" href="#main">
        Back to top <IconArrowUpRight size={11} />
      </a>
    </aside>
  );
}

function SummarySheet({ explanation }: { explanation: Explanation }) {
  return (
    <section class="summary-sheet" id="summary" aria-labelledby="summary-title">
      <div class="summary-sheet__head">
        <h2 id="summary-title">TL;DR</h2>
        <span class="field-label">The short version</span>
      </div>
      <p class="summary-sheet__sentence">{explanation.oneSentence}</p>
      <ol class="summary-list">
        {explanation.tldr.map((item, index) => (
          <li>
            <span class="summary-list__num" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <p>{item}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SectionView({ section, number }: { section: Section; number: number }) {
  return (
    <section class="article-section" id={section.id} aria-labelledby={`${section.id}-title`}>
      <h2 id={`${section.id}-title`}>
        <span class="article-section__num" aria-hidden="true">
          {String(number).padStart(2, "0")}
        </span>
        {section.title}
      </h2>
      <Blocks blocks={section.blocks} />
    </section>
  );
}

function TranslationPanel({ explanation }: { explanation: Explanation }) {
  return (
    <section class="translation-panel" id="eli5" aria-labelledby="eli5-title">
      <div class="translation-panel__head">
        <h2 id="eli5-title">The short version</h2>
        <span class="field-label">ELI5</span>
      </div>
      <div class="translation-panel__body">
        <Blocks blocks={explanation.eli5.body} />
      </div>
      <p class="translation-panel__limit">
        <span class="field-label">Where the analogy stops</span>
        <span>{explanation.eli5.limit}</span>
      </p>
    </section>
  );
}

function TradeoffPanel({ explanation }: { explanation: Explanation }) {
  return (
    <section class="article-section tradeoff-section" id="tradeoffs" aria-labelledby="tradeoffs-title">
      <h2 id="tradeoffs-title">Trade-offs</h2>
      <div class="tradeoff-list">
        {explanation.tradeoffs.map((tradeoff, index) => (
          <div class="tradeoff">
            <div class="tradeoff__title">
              <span class="tradeoff__num" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{tradeoff.title}</h3>
            </div>
            <p>{tradeoff.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function UsefulPanel({ explanation }: { explanation: Explanation }) {
  const showCaveats = explanation.caveats.length > 0;
  return (
    <section class="article-section useful-section" id="useful" aria-labelledby="useful-title">
      <div class={showCaveats ? "useful-grid" : "useful-grid useful-grid--single"}>
        <div>
          <h2 id="useful-title">When this matters</h2>
          <ul class="check-list">
            {explanation.whenUseful.map((item) => (
              <li>{item}</li>
            ))}
          </ul>
        </div>
        {showCaveats ? (
          <div>
            <h2 id="limits-title">What to keep in mind</h2>
            <ul class="limit-list" aria-labelledby="limits-title">
              {explanation.caveats.map((item) => (
                <li>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SourcesPanel({ sources }: { sources: SourceRef[] }) {
  return (
    <section class="sources-panel" id="sources" aria-labelledby="sources-title">
      <div class="section-head">
        <h2 id="sources-title">Sources</h2>
        <span class="section-head__meta">{plural(sources.length, "reference")}</span>
      </div>
      <ol class="source-list">
        {sources.map((source) => (
          <li id={`source-${source.id}`}>
            <span class="source-list__id">{source.id}</span>
            <div class="source-list__body">
              <a href={source.url} target="_blank" rel="noopener">
                {source.label} <IconArrowUpRight size={11} />
              </a>
              {source.note ? <p>{source.note}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      <p class="sources-panel__note">
        Citations in the text point to these entries. Claims attributed to the article come from
        the linked source; background material is marked as such. Quotes are kept short and linked.
      </p>
    </section>
  );
}

function SheetRecord({
  article,
  explanation,
  provenance,
}: {
  article: PublishedArticle;
  explanation: Explanation;
  provenance: ReturnType<typeof parseProvenance>;
}) {
  return (
    <section class="sheet-record" id="sheet-record" aria-labelledby="record-title">
      <div class="section-head">
        <h2 id="record-title">Sheet record</h2>
        <span class="section-head__meta">Immutable copy</span>
      </div>
      <dl class="record-grid">
        <div>
          <dt>Original title</dt>
          <dd>
            <a href={article.canonicalUrl} target="_blank" rel="noopener">
              {article.originalTitle}
            </a>
          </dd>
        </div>
        <div>
          <dt>Publisher</dt>
          <dd>{article.sourceName}</dd>
        </div>
        <div>
          <dt>Original date</dt>
          <dd>{formatDate(article.publishedAt)}</dd>
        </div>
        <div>
          <dt>Reading time</dt>
          <dd>{plural(explanation.readingMinutes, "minute")}</dd>
        </div>
        <div>
          <dt>Editorial</dt>
          <dd>{provenance.reviewedBy ?? "Understory editorial"}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd class="mono">{article.revisionId}</dd>
        </div>
        <div>
          <dt>Source snapshot</dt>
          <dd class="mono">{provenance.sourceSnapshotId ?? "fixture"}</dd>
        </div>
        <div>
          <dt>Pipeline</dt>
          <dd class="mono">
            {provenance.modelId ?? "editorial"} / {provenance.promptVersion ?? "v1"}
          </dd>
        </div>
      </dl>
      <p class="sheet-record__note">
        Published revisions are immutable. A new source snapshot or a substantive correction
        creates a new revision rather than editing this one.
      </p>
    </section>
  );
}

function ArticleFooter({
  adjacent,
}: {
  adjacent: { newer: ArticleWithSource | null; older: ArticleWithSource | null };
}) {
  return (
    <nav class="article-footer-nav" aria-label="More explainers">
      {adjacent.newer ? (
        <a class="article-footer-nav__item" href={`/articles/${adjacent.newer.slug}`}>
          <span class="field-label">
            <IconArrowLeft size={12} /> Newer sheet
          </span>
          <span>{adjacent.newer.contextHeadline ?? adjacent.newer.originalTitle}</span>
        </a>
      ) : (
        <span />
      )}
      {adjacent.older ? (
        <a class="article-footer-nav__item article-footer-nav__item--right" href={`/articles/${adjacent.older.slug}`}>
          <span class="field-label">
            Older sheet <IconArrowRight size={12} />
          </span>
          <span>{adjacent.older.contextHeadline ?? adjacent.older.originalTitle}</span>
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}

function SheetRail({
  article,
  explanation,
}: {
  article: PublishedArticle;
  explanation: Explanation;
}) {
  return (
    <aside class="sheet-rail" aria-label="Article details">
      <div class="sheet-card">
        <div class="sheet-card__head">
          <span class="field-label">Sheet</span>
          <span class="mono">{article.revisionId.slice(-10)}</span>
        </div>
        <dl class="sheet-fields">
          <div>
            <dt>Source</dt>
            <dd>
              <a href={article.sourceSiteUrl} target="_blank" rel="noopener">
                {article.sourceName} <IconArrowUpRight size={10} />
              </a>
            </dd>
          </div>
          <div>
            <dt>Original</dt>
            <dd>
              <a href={article.canonicalUrl} target="_blank" rel="noopener">
                Read at the publisher <IconArrowUpRight size={10} />
              </a>
            </dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd>{formatDate(article.publishedAt)}</dd>
          </div>
          <div>
            <dt>Explained</dt>
            <dd>{plural(explanation.readingMinutes, "minute")} read</dd>
          </div>
          <div>
            <dt>Diagram</dt>
            <dd>
              <a href="#diagram">{explanation.diagram.title}</a>
            </dd>
          </div>
        </dl>
      </div>

      <div class="reading-note">
        <span class="field-label">Reading note</span>
        <p>
          The explainer separates what the source reports from general background. Follow the
          numbered citations to the source list.
        </p>
      </div>
    </aside>
  );
}

function RelatedStrip({ articles }: { articles: ArticleWithSource[] }) {
  return (
    <section class="related-strip" aria-labelledby="related-title">
      <div class="section-head">
        <h2 id="related-title">Nearby</h2>
        <span class="section-head__meta">Other sheets</span>
      </div>
      <div class="related-grid">
        {articles.map((article) => (
          <a class="related-card" href={`/articles/${article.slug}`}>
            <span class="related-card__source">{article.sourceName}</span>
            <span class="related-card__title">
              {article.contextHeadline ?? article.originalTitle}
            </span>
            <span class="related-card__meta">
              {formatDate(article.publishedAt)}
              {article.readingMinutes ? ` / ${article.readingMinutes} min` : ""}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
