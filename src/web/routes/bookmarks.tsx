import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import { Layout } from "../components/layout";
import { IconBookmark } from "../components/icons";

export function renderBookmarks(c: Context<AppEnv>) {
  return c.render(
    <Layout
      title="Bookmarks"
      description="Sheets saved in this browser. Understory has no accounts; bookmarks stay on this device."
      path="/bookmarks"
      site={c.get("site")}
      siteUrl={c.env.SITE_URL}
      active="bookmarks"
    >
      <div class="page page--index">
        <header class="page-head">
          <h1>Bookmarks</h1>
          <p>
            Saved sheets live in this browser's local storage. There is no account and no server
            copy, so they do not follow you to another device.
          </p>
        </header>

        <div id="bookmarks-app" data-bookmarks-page>
          <div class="bookmarks-empty" data-bookmarks-empty hidden>
            <p class="empty-sheet__title">Nothing saved yet.</p>
            <p>
              Use the save button on any explainer. It will wait here until you clear the browser's
              storage.
            </p>
            <a class="text-link" href="/">
              Browse the index
            </a>
          </div>
          <p class="bookmarks-count" data-bookmarks-count hidden />
          <div class="feed-list" data-bookmarks-list />
        </div>

        <noscript>
          <div class="empty-sheet">
            <p class="empty-sheet__title">Bookmarks need JavaScript.</p>
            <p>
              Saving is a local-only convenience. The explainers themselves are fully readable
              without it.
            </p>
          </div>
        </noscript>

        <template id="bookmark-template">
          <article class="feed-item bookmark-item">
            <div class="feed-item__rank" aria-hidden="true" data-rank />
            <div class="feed-item__body">
              <div class="feed-item__topline">
                <span class="topic-tag" data-topic />
                <span class="feed-item__topline-rule" aria-hidden="true" />
                <span class="feed-item__source" data-source />
              </div>
              <h3 class="feed-item__headline">
                <a data-link />
              </h3>
              <p class="feed-item__origin">
                <span class="feed-item__origin-label">Original</span>{" "}
                <span data-original />
              </p>
              <div class="feed-item__meta">
                <span data-date />
                <span class="sep">/</span>
                <span data-reading />
                <span class="feed-item__meta-spacer" />
                <button
                  type="button"
                  class="save-button save-button--saved"
                  data-remove
                  aria-pressed="true"
                  aria-label="Remove bookmark"
                >
                  <IconBookmark size={14} filled />
                  <span class="save-button__label">Saved</span>
                </button>
              </div>
            </div>
          </article>
        </template>
      </div>
    </Layout>,
  );
}
