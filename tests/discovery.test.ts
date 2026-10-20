import { describe, expect, it } from "vitest";
import { parseDiscoveryHtml, parseHeadingDate, parseOpml } from "../src/pipeline/discovery";

const page = `
  <h2>Tuesday, October 20, 2026</h2>
  <div class="entries">
    <div class="entry">
      <span class="source"><a href="http://www.codenameone.com/blog.html">CodeName One</a></span>
      <span class="title"><a href="https://www.codenameone.com/blog/desktop-tools/?utm_source=rss">Give Your Desktop App a Useful Title Bar</a></span>
    </div>
    <div class="entry">
      <span class="source"><a href="https://robots.thoughtbot.com/">Thoughtbot</a></span>
      <span class="title"><a href="https://feed.thoughtbot.com/link/24077/17501068/design-systems">Design systems in an AI era; what changes?</a></span>
    </div>
  </div>
  <h2>Monday, October 19, 2026</h2>
  <div class="entries">
    <div class="entry">
      <span class="source"><a href="https://example.com">Example &amp; Co</a></span>
      <span class="title"><a href="https://example.com/post">A &lt;b&gt;real&lt;/b&gt; post &amp; more</a></span>
    </div>
  </div>
`;

describe("discovery page parsing", () => {
  it("parses dates from the heading and attaches them to entries", () => {
    const posts = parseDiscoveryHtml(page);
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({
      title: "Give Your Desktop App a Useful Title Bar",
      sourceName: "CodeName One",
      publishedAt: "2026-10-20T12:00:00.000Z",
    });
    expect(posts[0]?.url).toBe(
      "https://www.codenameone.com/blog/desktop-tools",
    );
    expect(posts[2]?.publishedAt).toBe("2026-10-19T12:00:00.000Z");
  });

  it("decodes entities in titles and source names", () => {
    const posts = parseDiscoveryHtml(page);
    expect(posts[2]?.title).toBe("A <b>real</b> post & more");
    expect(posts[2]?.sourceName).toBe("Example & Co");
  });

  it("deduplicates repeated links", () => {
    const posts = parseDiscoveryHtml(page + page);
    expect(posts).toHaveLength(3);
  });

  it("ignores malformed dates rather than inventing one", () => {
    expect(parseHeadingDate("Tuesday, October 20, 2026")).toBe(
      "2026-10-20T12:00:00.000Z",
    );
    expect(parseHeadingDate("Tuesday, Febtober 20, 2026")).toBeNull();
    expect(parseHeadingDate("Yesterday")).toBeNull();
  });
});

describe("OPML parsing", () => {
  it("reads single and double quoted outline attributes", () => {
    const outlines = parseOpml(`
      <opml version="2.0">
        <body>
          <outline text="Cloudflare Blog" title="Cloudflare Blog" type="rss"
            xmlUrl="https://blog.cloudflare.com/rss/" htmlUrl="https://blog.cloudflare.com/" />
          <outline title='Example' type='rss' xmlUrl='https://example.com/feed.xml' htmlUrl='https://www.example.com/' />
        </body>
      </opml>
    `);
    expect(outlines).toEqual([
      {
        name: "Cloudflare Blog",
        siteUrl: "https://blog.cloudflare.com/",
        feedUrl: "https://blog.cloudflare.com/rss/",
        host: "blog.cloudflare.com",
      },
      {
        name: "Example",
        siteUrl: "https://www.example.com/",
        feedUrl: "https://example.com/feed.xml",
        host: "example.com",
      },
    ]);
  });

  it("drops outlines with no feed or invalid site URL", () => {
    expect(parseOpml('<outline title="No feed" htmlUrl="https://example.com/" />')).toEqual([]);
    expect(
      parseOpml('<outline title="Bad" xmlUrl="https://example.com/feed" htmlUrl="javascript:x" />'),
    ).toEqual([]);
  });
});
