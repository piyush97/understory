import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { listSources } from "../../infrastructure/db";
import { Layout } from "../components/layout";
import { IconArrowUpRight } from "../components/icons";
import { plural } from "../lib/format";

export async function renderSources(c: Context<AppEnv>) {
  const sources = await listSources(c.env.DB);

  return c.render(
    <Layout
      title="Sources"
      description="The publishers Understory reads, with links to their engineering blogs and the number of explainers drawn from each."
      path="/sources"
      site={c.get("site")}
      siteUrl={c.env.SITE_URL}
      active="sources"
    >
      <div class="page page--index">
        <header class="page-head">
          <h1>Sources</h1>
          <p>
            Understory discovers posts through{" "}
            <a href="https://engineeringblogs.xyz/" target="_blank" rel="noopener">
              engineeringblogs.xyz <IconArrowUpRight size={11} />
            </a>
            . Attribution stays with the publisher. The link on every explainer goes to the
            original article.
          </p>
        </header>

        <div class="source-table" role="table" aria-label="Publishers">
          <div class="source-table__head" role="row">
            <span role="columnheader">Publisher</span>
            <span role="columnheader">Host</span>
            <span role="columnheader">Explained</span>
            <span role="columnheader">Discovered</span>
          </div>
          {sources.map((source) => (
            <div class="source-table__row" role="row" id={`source-${source.id}`}>
              <span role="cell" class="source-table__name">
                <a href={source.siteUrl} target="_blank" rel="noopener">
                  {source.name} <IconArrowUpRight size={10} />
                </a>
              </span>
              <span role="cell" class="source-table__host mono">
                {source.host}
              </span>
              <span role="cell" class="source-table__count">
                {source.explainedCount}
              </span>
              <span role="cell" class="source-table__count">
                {plural(source.articleCount, "article")}
              </span>
            </div>
          ))}
        </div>

        <p class="page-note">
          A publisher can appear here after one post has been discovered. The explained count only
          includes sheets that passed review.
        </p>
      </div>
    </Layout>,
  );
}
