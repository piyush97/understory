import type { Context } from "hono";
import { getSiteState } from "../../infrastructure/db";
import type { AppEnv } from "../../shared/env";
import { Layout } from "../components/layout";
import { IconArrowLeft } from "../components/icons";

async function siteFor(c: Context<AppEnv>) {
  if (c.get("site")) return c.get("site")!;
  try {
    return await getSiteState(c.env.DB);
  } catch {
    return {
      published: 0,
      sources: 0,
      topics: 0,
      inReview: 0,
      publicationVersion: "0",
    };
  }
}

export async function renderNotFound(c: Context<AppEnv>) {
  const site = await siteFor(c);
  c.status(404);
  return c.render(
    <Layout
      title="Sheet not found"
      description="This explainer is not in the current edition."
      path="/404"
      site={site}
      siteUrl={c.env.SITE_URL}
      noindex
    >
      <div class="error-page">
        <p class="error-page__code" aria-hidden="true">
          404 / No sheet
        </p>
        <h1>That explainer is not on this desk.</h1>
        <p>
          The link may be old, or the revision may have been withdrawn. The index is the best
          place to pick up the trail.
        </p>
        <a class="button button--solid" href="/">
          <IconArrowLeft size={14} /> Back to the index
        </a>
      </div>
    </Layout>,
  );
}

export async function renderError(c: Context<AppEnv>) {
  const site = await siteFor(c);
  c.status(500);
  return c.render(
    <Layout
      title="The sheet jammed"
      description="Understory could not render this page."
      path="/500"
      site={site}
      siteUrl={c.env.SITE_URL}
      noindex
    >
      <div class="error-page">
        <p class="error-page__code" aria-hidden="true">
          500 / Sheet jam
        </p>
        <h1>The drawing did not finish.</h1>
        <p>
          Something failed while rendering this page. The reading is still on the original
          publisher, and the index is still available.
        </p>
        <a class="button button--solid" href="/">
          <IconArrowLeft size={14} /> Back to the index
        </a>
      </div>
    </Layout>,
  );
}
