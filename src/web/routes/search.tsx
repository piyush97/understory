import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { searchArticles } from "../../infrastructure/db";
import { Layout } from "../components/layout";
import { FeedItem } from "../components/feed-item";

const MAX_QUERY_LENGTH = 120;

export async function renderSearch(c: Context<AppEnv>) {
  const query = (c.req.query("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const results = query ? await searchArticles(c.env.DB, query) : [];
  const path = query ? `/search?q=${encodeURIComponent(query)}` : "/search";
  const title = query ? `Search: ${query}` : "Search";

  return c.render(
    <Layout
      title={title}
      description="Search Understory explainers by keyword: mechanisms, systems, and the trade-offs behind the announcement."
      path={path}
      site={c.get("site")}
      siteUrl={c.env.SITE_URL}
      active={null}
      noindex
    >
      <div class="page page--index">
        <header class="page-head">
          <h1>Search</h1>
          <p>Find explainers by keyword. Results cover titles, deks, and the explainer body.</p>
        </header>

        <form class="login-form" action="/search" method="get" role="search">
          <label class="field-label" for="search-q">
            Search explainers
          </label>
          <input
            id="search-q"
            name="q"
            type="search"
            value={query}
            maxlength={MAX_QUERY_LENGTH}
            autocomplete="off"
            required
          />
          <button class="button" type="submit">
            Search
          </button>
        </form>

        {query ? (
          <p class="page-note" role="status">
            {results.length > 0
              ? results.length === 1
                ? `1 explainer matches “${query}”.`
                : `${results.length} explainers match “${query}”.`
              : `No explainers match “${query}”.`}
          </p>
        ) : (
          <p class="page-note">
            Try a system, a technique, or a term from a post you remember.
          </p>
        )}

        {results.length > 0 ? (
          <section class="feed-section" aria-label="Search results">
            <div class="feed-list">
              {results.map((article, index) => (
                <FeedItem article={article} index={index + 1} />
              ))}
            </div>
          </section>
        ) : query ? (
          <div class="empty-sheet">
            <p class="empty-sheet__title">Nothing filed under that yet.</p>
            <p>Try a shorter term, or browse the full index.</p>
            <a class="text-link" href="/">
              Back to the index
            </a>
          </div>
        ) : null}
      </div>
    </Layout>,
  );
}
