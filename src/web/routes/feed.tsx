import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import type { ArticleWithSource } from "../../domain/article";
import { encodeCursor, decodeCursor } from "../../domain/pagination";
import { getFeedLead, listFeedPage, listPendingArticles, listTopics } from "../../infrastructure/db";
import { Layout } from "../components/layout";
import { FeedItem } from "../components/feed-item";
import { LeadStory } from "../components/lead";
import { parseExplanation } from "../lib/content";
import { formatDate } from "../lib/format";
import { IconArrowRight } from "../components/icons";

export async function renderFeed(c: Context<AppEnv>) {
  const db = c.env.DB;
  const site = c.get("site");
  const topicId = c.req.query("topic")?.trim() || null;
  const cursor = decodeCursor(c.req.query("cursor"));

  const [topics, page, pending] = await Promise.all([
    listTopics(db),
    listFeedPage(db, { topic: topicId, cursor, limit: 20 }),
    listPendingArticles(db, 3),
  ]);

  const topic = topicId ? topics.find((item) => item.id === topicId) ?? null : null;
  const isFirstPage = !cursor && !topicId;
  const lead = isFirstPage ? await getFeedLead(db) : null;
  const leadExplanation = lead ? parseExplanation(lead.revisionContent) : null;
  const showLead = Boolean(lead && leadExplanation);

  const leadId = showLead && lead ? lead.id : null;
  const items = page.items.filter((article) => article.id !== leadId);
  const lastItem = page.items[page.items.length - 1];
  const nextCursor = page.hasMore && lastItem
    ? encodeCursor({ publishedAt: lastItem.publishedAt, id: lastItem.id })
    : null;
  const nextHref = nextCursor
    ? `/${topicId ? `?topic=${encodeURIComponent(topicId)}&cursor=${encodeURIComponent(nextCursor)}` : `?cursor=${encodeURIComponent(nextCursor)}`}`
    : null;

  const title = topic ? `${topic.label} explainers` : "Understory";
  const description = topic
    ? topic.description ?? `Reviewed explainers about ${topic.label.toLowerCase()}.`
    : "Engineering blogs, explained. The latest posts turned into reviewed explainers with context, diagrams, and sources.";
  const path = topic ? `/?topic=${encodeURIComponent(topic.id)}` : "/";

  return c.render(
    <Layout
      title={title}
      description={description}
      path={path}
      site={site}
      siteUrl={c.env.SITE_URL}
      active={topicId ? null : "index"}
    >
      <div class="page page--index">
        <section class="index-intro" aria-labelledby="index-title">
          <div class="index-intro__copy">
            <h1 id="index-title">Engineering blogs, explained.</h1>
            <p class="index-intro__dek">
              The latest posts from engineering blogs, turned into reviewed explainers. Context,
              mechanism, diagrams, and the trade-offs the announcement leaves out.
            </p>
          </div>
          <div class="index-intro__stamp" aria-label="Edition summary">
            <span class="field-label">Latest edition</span>
            <strong>{lead ? formatDate(lead.publishedAt) : formatDate(new Date().toISOString())}</strong>
            <span>{site.published} explainers / {site.sources} sources</span>
          </div>
        </section>

        <nav class="topic-strip" aria-label="Filter by topic">
          <a
            href="/"
            class={topicId ? "topic-strip__item" : "topic-strip__item topic-strip__item--active"}
            aria-current={topicId ? undefined : "page"}
          >
            All <span class="topic-strip__count">{site.published}</span>
          </a>
          {topics
            .filter((item) => item.count > 0)
            .map((item) => (
              <a
                href={`/?topic=${encodeURIComponent(item.id)}`}
                class={
                  topicId === item.id
                    ? "topic-strip__item topic-strip__item--active"
                    : "topic-strip__item"
                }
                aria-current={topicId === item.id ? "page" : undefined}
              >
                {item.label} <span class="topic-strip__count">{item.count}</span>
              </a>
            ))}
        </nav>

        {showLead && lead && leadExplanation ? (
          <LeadStory article={lead} explanation={leadExplanation} />
        ) : null}

        <section class="feed-section" aria-labelledby="latest-title">
          <div class="section-head">
            <h2 id="latest-title">{topic ? `${topic.label} explainers` : "Latest explainers"}</h2>
            <span class="section-head__meta">
              {topic?.description ?? "Newest first"}
            </span>
          </div>

          {items.length > 0 ? (
            <div class="feed-list">
              {items.map((article, index) => (
                <FeedItem article={article} index={index + 1} />
              ))}
            </div>
          ) : (
            <div class="empty-sheet">
              <p class="empty-sheet__title">
                {topic ? "Nothing on this topic yet." : "The first sheet is still being drawn."}
              </p>
              <p>
                {topic
                  ? "Try another topic, or read the full index."
                  : "The pipeline is reading sources now. Published explainers will appear here after review."}
              </p>
              <a class="text-link" href={topic ? "/" : "/about"}>
                {topic ? "Back to the full index" : "How the pipeline works"}{" "}
                <IconArrowRight size={15} />
              </a>
            </div>
          )}

          {nextHref ? (
            <div class="pagination">
              <a class="pagination__next" href={nextHref}>
                Next sheet <IconArrowRight size={15} />
              </a>
            </div>
          ) : null}
        </section>

        {isFirstPage && pending.length > 0 ? (
          <section class="bench-section" aria-labelledby="bench-title">
            <div class="section-head">
              <h2 id="bench-title">On the bench</h2>
              <span class="section-head__meta">In the pipeline / not yet published</span>
            </div>
            <p class="bench-section__note">
              These posts have been discovered. They appear without an explainer until a draft
              passes review.
            </p>
            <div class="feed-list feed-list--dense">
              {pending.map((article, index) => (
                <FeedItem article={article} index={index + 1} pending />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Layout>,
  );
}
