import { describe, expect, it } from "vitest";
import { FIXTURE_ARTICLES } from "../src/content/fixtures";
import { validateExplanation } from "../src/domain/explanation";

const published = FIXTURE_ARTICLES.filter((fixture) => fixture.article.status === "published");

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

describe("published fixtures", () => {
  it("keeps the launch edition populated", () => {
    expect(published.length).toBeGreaterThanOrEqual(10);
  });

  it("has a valid explanation, snapshot, and matching topic for every published sheet", () => {
    for (const fixture of published) {
      const result = validateExplanation(fixture.explanation);
      expect(result.ok, `${fixture.article.slug}: ${JSON.stringify(result)}`).toBe(true);
      expect(fixture.snapshot, fixture.article.slug).toBeDefined();
      expect(fixture.explanation?.topic).toBe(fixture.topic.id);
    }
  });

  it("uses short quotations instead of copied source paragraphs", () => {
    for (const fixture of published) {
      const snapshot = fixture.snapshot;
      expect(snapshot, fixture.article.slug).toBeDefined();
      if (!snapshot) continue;

      expect(snapshot.blocks.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.blocks.length).toBeLessThanOrEqual(3);

      let totalWords = 0;
      for (const block of snapshot.blocks) {
        expect(block.kind, `${fixture.article.slug}/${block.id}`).toBe("quote");
        expect(wordCount(block.text), `${fixture.article.slug}/${block.id}`).toBeLessThanOrEqual(50);
        totalWords += wordCount(block.text);
      }

      expect(totalWords, fixture.article.slug).toBeLessThanOrEqual(160);
      expect(snapshot.wordCount, fixture.article.slug).toBeGreaterThanOrEqual(totalWords);
    }
  });

  it("links the canonical article from the source list", () => {
    for (const fixture of published) {
      const sources = fixture.explanation?.sources ?? [];
      expect(
        sources.some((source) => source.url === fixture.article.canonicalUrl),
        `${fixture.article.slug} is missing its canonical source link`,
      ).toBe(true);
    }
  });

  it("keeps article slugs, ids, and canonical URLs unique", () => {
    const slugs = new Set<string>();
    const ids = new Set<string>();
    const urls = new Set<string>();

    for (const fixture of FIXTURE_ARTICLES) {
      expect(slugs.has(fixture.article.slug), `duplicate slug ${fixture.article.slug}`).toBe(false);
      expect(ids.has(fixture.article.id), `duplicate id ${fixture.article.id}`).toBe(false);
      expect(urls.has(fixture.article.canonicalUrl), `duplicate URL ${fixture.article.canonicalUrl}`).toBe(
        false,
      );
      slugs.add(fixture.article.slug);
      ids.add(fixture.article.id);
      urls.add(fixture.article.canonicalUrl);
    }
  });
});
