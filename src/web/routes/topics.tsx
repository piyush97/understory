import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { listTopics } from "../../infrastructure/db";
import { Layout } from "../components/layout";
import { IconArrowRight } from "../components/icons";
import { plural } from "../lib/format";

export async function renderTopics(c: Context<AppEnv>) {
  const allTopics = await listTopics(c.env.DB);
  const topics = allTopics.filter((topic) => topic.count > 0);

  return c.render(
    <Layout
      title="Topics"
      description="Browse Understory explainers by subject, from AI infrastructure to query engines."
      path="/topics"
      site={c.get("site")}
      siteUrl={c.env.SITE_URL}
      active="topics"
    >
      <div class="page page--index">
        <header class="page-head">
          <h1>Topics</h1>
          <p>
            Every explainer is filed under one subject. The counts reflect published sheets, not
            the queue.
          </p>
        </header>

        <div class="topic-index">
          {topics.map((topic, index) => (
            <a class="topic-row" href={`/?topic=${encodeURIComponent(topic.id)}`}>
              <span class="topic-row__num" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span class="topic-row__body">
                <span class="topic-row__title">{topic.label}</span>
                {topic.description ? (
                  <span class="topic-row__description">{topic.description}</span>
                ) : null}
              </span>
              <span class="topic-row__count">
                {plural(topic.count, "sheet")}
                <IconArrowRight size={14} />
              </span>
            </a>
          ))}
        </div>

        <p class="page-note">
          Only topics with at least one published sheet are listed. A new subject appears after
          its first explainer passes review.
        </p>
      </div>
    </Layout>,
  );
}
