import type { Context } from "hono";
import type { AppEnv } from "../../shared/env";
import type { Diagram } from "../../domain/explanation";
import { Layout } from "../components/layout";
import { DiagramPlate } from "../components/diagram";
import { IconArrowUpRight } from "../components/icons";

const pipelineDiagram: Diagram = {
  kind: "flow",
  title: "From a link to a reviewed sheet",
  description:
    "Discovery, extraction, generation, validation, and review run as separate steps. A failed step stays in the queue and does not reach the public index.",
  conceptual: true,
  nodes: [
    { id: "discover", label: "Discover", detail: "engineeringblogs.xyz" },
    { id: "extract", label: "Extract", detail: "article text and structure" },
    { id: "draft", label: "Draft", detail: "Workers AI, bounded" },
    { id: "validate", label: "Validate", detail: "schema, citations, diagram" },
    { id: "review", label: "Review", detail: "a person decides" },
    { id: "publish", label: "Publish", detail: "immutable revision" },
  ],
  edges: [
    { from: "discover", to: "extract" },
    { from: "extract", to: "draft" },
    { from: "draft", to: "validate" },
    { from: "validate", to: "review" },
    { from: "review", to: "publish" },
  ],
  caption:
    "The queue and D1 job rows make each step retryable. The public site never calls a model on a reader request.",
};

export function renderAbout(c: Context<AppEnv>) {
  return c.render(
    <Layout
      title="About"
      description="How Understory turns engineering blog posts into reviewed explainers, what it will not do, and how the free-tier budget works."
      path="/about"
      site={c.get("site")}
      siteUrl={c.env.SITE_URL}
      active="about"
    >
      <div class="page page--about">
        <header class="page-head page-head--about">
          <h1>A reading layer with receipts.</h1>
          <p>
            Understory watches the engineering blogs that{" "}
            <a href="https://engineeringblogs.xyz/" target="_blank" rel="noopener">
              engineeringblogs.xyz <IconArrowUpRight size={11} />
            </a>{" "}
            already aggregates. When a post looks worth the time, it builds an explainer:
            context, mechanism, a diagram, an ELI5, the trade-offs, and the sources behind every
            substantive claim.
          </p>
        </header>

        <div class="about-layout">
          <div class="about-main">
            <section class="about-section" id="how">
              <h2>How an explainer is made</h2>
              <p>
                The pipeline is deliberately boring. A scheduled Worker reads the public listing,
                then records new links in D1. A queue job fetches the article, extracts readable
                blocks, and stores a snapshot with a content hash. A second job asks Workers AI
                for a structured explanation. The draft is validated against a schema before it
                can enter the review queue.
              </p>
              <p>
                Validation is not a spell check. Every citation must point to a source entry, every
                source entry must be a real HTTP URL, diagram nodes must connect to nodes that
                exist, and the prose has to pass length and structure limits. A draft that fails
                stays in the job table with its error. It does not appear on the site.
              </p>
              <DiagramPlate diagram={pipelineDiagram} figure="A" compact />
              <p>
                A person reviews the draft against the snapshot. Approving it writes an immutable
                revision, points the article at that revision, and increments the publication
                version. The public pages are precomputed. Readers never wait for a model.
              </p>
            </section>

            <section class="about-section" id="editorial">
              <h2>Editorial rules</h2>
              <ul class="about-rules">
                <li>
                  <strong>Explain the mechanism.</strong> An announcement is a starting point. The
                  explainer should leave the reader able to describe how the thing works.
                </li>
                <li>
                  <strong>Attribute claims.</strong> Numbers, quotes, and findings belong to the
                  linked source. Background that is not in the source is marked as background.
                </li>
                <li>
                  <strong>Show the limits.</strong> Every explainer has a caveats section and an
                  ELI5 limit. If the evidence is thin, the sheet says so.
                </li>
                <li>
                  <strong>Do not invent.</strong> No fabricated benchmarks, quotes, customer
                  stories, or URLs. The model writes from the extracted snapshot, and a validator
                  rejects citations that point nowhere.
                </li>
                <li>
                  <strong>Keep the original close.</strong> The publisher link is in the header, the
                  sheet record, and the sources list. Understory is not a replacement for the
                  article.
                </li>
                <li>
                  <strong>Write like a person.</strong> Plain sentences, concrete verbs, no sales
                  language. Drafts are edited for the tells that make machine prose tiring to read.
                </li>
              </ul>
            </section>

            <section class="about-section" id="not">
              <h2>What it does not do</h2>
              <ul class="about-rules about-rules--plain">
                <li>No accounts, comments, voting, or public submissions in this version.</li>
                <li>No arbitrary URL ingestion and no unrestricted URL proxy.</li>
                <li>No model inference on a reader request, and no chat with the article.</li>
                <li>No reproduction of the full original text. Links and short quotes only.</li>
                <li>No claim that a generated draft is a fact-check. A person reviews it first.</li>
              </ul>
            </section>

            <section class="about-section" id="budget">
              <h2>The free-tier budget</h2>
              <p>
                The project runs on Cloudflare's free plan and is designed to stay there. The
                binding constraint is Workers AI: 10,000 neurons per day. Understory reserves
                8,000 and pauses new generation when the reservation would cross that line.
                Reading the site is never blocked by the AI budget.
              </p>
              <div class="budget-table" role="table" aria-label="Free-tier limits">
                <div class="budget-table__row budget-table__row--head" role="row">
                  <span role="columnheader">Service</span>
                  <span role="columnheader">Free allowance</span>
                  <span role="columnheader">How it is used</span>
                </div>
                <div class="budget-table__row" role="row">
                  <span role="cell">Workers</span>
                  <span role="cell">100,000 requests/day, 10 ms CPU</span>
                  <span role="cell">Server-rendered pages and the pipeline HTTP surface</span>
                </div>
                <div class="budget-table__row" role="row">
                  <span role="cell">D1</span>
                  <span role="cell">5M rows read/day, 100k written/day, 500 MB</span>
                  <span role="cell">Articles, snapshots, revisions, jobs, budget ledger</span>
                </div>
                <div class="budget-table__row" role="row">
                  <span role="cell">Queues</span>
                  <span role="cell">10,000 operations/day, 24 h retention</span>
                  <span role="cell">Extraction and generation jobs, with retries</span>
                </div>
                <div class="budget-table__row" role="row">
                  <span role="cell">Workers AI</span>
                  <span role="cell">10,000 neurons/day</span>
                  <span role="cell">8,000 reserved for explainer drafts</span>
                </div>
              </div>
              <p class="about-fineprint">
                Allowances change. The numbers above are the plan limits this build was designed
                against, not a promise from Cloudflare.
              </p>
            </section>

            <section class="about-section" id="stack">
              <h2>The stack</h2>
              <p>
                Two Workers share one D1 database: a web Worker for pages and an editorial
                surface, and a pipeline Worker for the cron trigger and queue consumer. The web
                Worker renders HTML with Hono and a small amount of JavaScript for saving sheets.
                The pipeline uses HTMLRewriter for extraction, Workers AI for drafts, and a
                deterministic SVG renderer for diagrams.
              </p>
              <p>
                Diagrams are not model-authored SVG. The model returns a validated graph of nodes
                and edges; the Worker lays it out and renders the SVG. That keeps the drawing
                legible, accessible, and free of injected markup.
              </p>
            </section>

            <section class="about-section" id="corrections">
              <h2>Corrections</h2>
              <p>
                Published revisions do not change in place. A correction creates a new revision
                with a new source snapshot, and the sheet record points at both. If a source
                changes materially, the explainer can be rebuilt without erasing the version a
                reader already saw.
              </p>
            </section>

            <section class="about-section" id="credits">
              <h2>Credits</h2>
              <p>
                Discovery is built on{" "}
                <a href="https://engineeringblogs.xyz/" target="_blank" rel="noopener">
                  engineeringblogs.xyz <IconArrowUpRight size={11} />
                </a>
                , a public index run by Peter Cooper. The original authors and publishers own
                their work. Type is set in{" "}
                <a href="/assets/fonts/OFL-Barlow-Condensed.txt">Barlow Condensed</a>,{" "}
                <a href="/assets/fonts/OFL-Source-Serif-4.txt">Source Serif 4</a>, and{" "}
                <a href="/assets/fonts/OFL-Spline-Sans-Mono.txt">Spline Sans Mono</a>, all under
                the SIL Open Font License.
              </p>
              <p>
                Understory's code is MIT-licensed. Its original explainer prose and diagrams are
                CC BY 4.0. Publisher articles, quotations, fonts, and trademarks are excluded from
                those licenses; the source links carry the original terms.
              </p>
            </section>
          </div>

          <aside class="about-rail" aria-label="About contents">
            <p class="rail-label">On this sheet</p>
            <nav class="about-nav">
              <a href="#how">How it is made</a>
              <a href="#editorial">Editorial rules</a>
              <a href="#not">What it does not do</a>
              <a href="#budget">Free-tier budget</a>
              <a href="#stack">The stack</a>
              <a href="#corrections">Corrections</a>
              <a href="#credits">Credits</a>
            </nav>
          </aside>
        </div>
      </div>
    </Layout>,
  );
}
