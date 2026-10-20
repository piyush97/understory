import type { Child } from "hono/jsx";
import type { SiteState } from "../../infrastructure/db";
import { issueNumber } from "../lib/format";
import { IconArrowUpRight } from "./icons";

export type ActiveNav = "index" | "topics" | "sources" | "bookmarks" | "about" | null;

type LayoutProps = {
  children: Child;
  title: string;
  description: string;
  path: string;
  site: SiteState;
  siteUrl?: string;
  active?: ActiveNav;
  noindex?: boolean;
  bodyClass?: string;
  ogType?: "website" | "article";
};

const NAV: Array<{ id: Exclude<ActiveNav, null>; label: string; href: string }> = [
  { id: "index", label: "Index", href: "/" },
  { id: "topics", label: "Topics", href: "/topics" },
  { id: "sources", label: "Sources", href: "/sources" },
  { id: "bookmarks", label: "Bookmarks", href: "/bookmarks" },
  { id: "about", label: "About", href: "/about" },
];

export function Layout({
  children,
  title,
  description,
  path,
  site,
  siteUrl = "https://understory.example",
  active = null,
  noindex = false,
  bodyClass = "",
  ogType = "website",
}: LayoutProps) {
  const fullTitle = title === "Understory" ? title : `${title} · Understory`;
  const canonical = new URL(path, siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`).toString();
  const issue = issueNumber(site.publicationVersion);
  const ogImage = new URL("/assets/og.png", siteUrl).toString();

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{fullTitle}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <meta name="robots" content={noindex ? "noindex, nofollow" : "index, follow"} />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#f4f2ec" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#151513" media="(prefers-color-scheme: dark)" />
        <meta property="og:type" content={ogType} />
        <meta property="og:site_name" content="Understory" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="Understory field note: engineering blogs, explained." />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content={ogImage} />
        <meta name="twitter:image:alt" content="Understory field note: engineering blogs, explained." />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
        <link rel="preload" href="/assets/fonts/barlow-condensed-600.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="preload" href="/assets/fonts/source-serif-4.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="stylesheet" href="/assets/styles.css" />
        <script src="/assets/app.js" defer></script>
      </head>
      <body class={bodyClass}>
        <a class="skip-link" href="#main">
          Skip to the reading
        </a>
        <header class="masthead">
          <div class="masthead__bar">
            <a class="brand" href="/" aria-label="Understory home">
              <span class="brand__mark" aria-hidden="true" />
              <span class="brand__name">Understory</span>
              <span class="brand__tagline">Engineering blogs, explained</span>
            </a>
            <div class="stamp" aria-hidden="true">
              <span class="stamp__row">Field notes</span>
              <span class="stamp__row stamp__row--strong">Issue {issue}</span>
            </div>
          </div>
          <div class="masthead__rule" />
          <div class="masthead__navrow">
            <nav class="nav" aria-label="Primary">
              {NAV.map((item) => (
                <a
                  href={item.href}
                  class={active === item.id ? "nav__link nav__link--active" : "nav__link"}
                  aria-current={active === item.id ? "page" : undefined}
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <p class="masthead__meta">
              <span>{site.published}</span> explained <span class="sep">/</span>{" "}
              <span>{site.sources}</span> sources <span class="sep">/</span> rev{" "}
              <span>{issue}</span>
            </p>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer class="site-footer">
          <div class="colophon">
            <div class="colophon__field">
              <span class="field-label">Drawn from</span>
              <a class="field-value" href="https://engineeringblogs.xyz/" rel="noopener">
                engineeringblogs.xyz <IconArrowUpRight size={11} />
              </a>
            </div>
            <div class="colophon__field">
              <span class="field-label">Explained</span>
              <span class="field-value">{site.published} articles</span>
            </div>
            <div class="colophon__field">
              <span class="field-label">Sources</span>
              <span class="field-value">{site.sources} publishers</span>
            </div>
            <div class="colophon__field">
              <span class="field-label">Edition</span>
              <span class="field-value">Rev {issue}</span>
            </div>
          </div>
          <div class="site-footer__note">
            <p>
              Understory is an independent reading layer. Original articles belong to their
              authors and publishers; every explainer links to the source it was built from.
            </p>
            <nav class="footer-nav" aria-label="Footer">
              <a href="/about">How it works</a>
              <a href="/about#editorial">Editorial policy</a>
              <a href="/sources">Sources</a>
            </nav>
            <p class="site-footer__stamp">Set in Barlow Condensed, Source Serif 4, and Spline Sans Mono.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
