import { describe, expect, it } from "vitest";
import { FIXTURE_ARTICLES, type FixtureArticle } from "../src/content/fixtures";
import type { Explanation } from "../src/domain/explanation";
import { attemptGeneration } from "../src/pipeline/generate";
import type { GenerationMaterial } from "../src/pipeline/prompt";

// Explainer-quality eval: each case feeds a model response through the same
// gate the pipeline uses (attemptGeneration: parse -> schema -> cite repair ->
// editorial rules). Rejected cases reproduce the failure buckets measured in
// production (docs/metrics.md, scripts/metrics.sql query 4).

type EvalCase = {
  name: string;
  fixture: FixtureArticle;
  mutate?: (explanation: Explanation) => void;
  /** null = must pass the gate; otherwise the issue path the gate must report. */
  expectIssuePath: string | null;
};

const reviewed = FIXTURE_ARTICLES.filter(
  (fixture): fixture is FixtureArticle & { explanation: Explanation; snapshot: NonNullable<FixtureArticle["snapshot"]> } =>
    fixture.article.status === "published" && Boolean(fixture.explanation && fixture.snapshot),
);
const [first, second, third] = reviewed;
if (!first || !second || !third) throw new Error("explainer eval needs three reviewed fixtures");

const EVAL_CASES: EvalCase[] = [
  { name: `reviewed explainer: ${first.article.slug}`, fixture: first, expectIssuePath: null },
  { name: `reviewed explainer: ${second.article.slug}`, fixture: second, expectIssuePath: null },
  { name: `reviewed explainer: ${third.article.slug}`, fixture: third, expectIssuePath: null },
  {
    name: "excerpt block id used as a citation is stripped, then passes",
    fixture: first,
    mutate: (explanation) => {
      const block = explanation.sections[0]?.blocks.find((candidate) => candidate.type === "p");
      if (block?.type !== "p" || !block.runs[0]) throw new Error("fixture shape changed");
      block.runs[0].cite = "b1";
    },
    expectIssuePath: null,
  },
  {
    name: "fewer than three sections",
    fixture: second,
    mutate: (explanation) => {
      explanation.sections = explanation.sections.slice(0, 2);
    },
    expectIssuePath: "sections",
  },
  {
    name: "source URL not in the provided material",
    fixture: third,
    mutate: (explanation) => {
      explanation.sources.push({ ...explanation.sources[0]!, id: "s9", url: "https://invented.example/paper" });
    },
    expectIssuePath: `sources.${third.explanation.sources.length}.url`,
  },
  {
    name: "topic outside the allowed list",
    fixture: first,
    mutate: (explanation) => {
      explanation.topic = "game-development";
    },
    expectIssuePath: "topic",
  },
  {
    name: "duplicate section id",
    fixture: second,
    mutate: (explanation) => {
      explanation.sections[1]!.id = explanation.sections[0]!.id;
    },
    expectIssuePath: "sections.1.id",
  },
  {
    name: "diagram edge to an unknown node",
    fixture: third,
    mutate: (explanation) => {
      explanation.diagram.edges[0]!.to = "statement";
    },
    expectIssuePath: "diagram.edges.0.to",
  },
];

function materialFor(fixture: FixtureArticle & { explanation: Explanation; snapshot: NonNullable<FixtureArticle["snapshot"]> }): GenerationMaterial {
  return {
    articleTitle: fixture.article.originalTitle,
    articleUrl: fixture.article.canonicalUrl,
    articlePublishedAt: fixture.article.publishedAt,
    sourceName: fixture.source.name,
    snapshot: {
      articleId: fixture.article.id,
      title: fixture.article.originalTitle,
      url: fixture.article.canonicalUrl,
      fetchedAt: fixture.snapshot.fetchedAt,
      extractorVersion: "eval",
      wordCount: fixture.snapshot.wordCount,
      blocks: fixture.snapshot.blocks,
    },
    links: fixture.explanation.sources.slice(1).map((source) => ({ url: source.url, host: new URL(source.url).host })),
  };
}

function aiReturning(explanation: Explanation): Ai {
  return { run: async () => ({ response: JSON.stringify(explanation) }) } as unknown as Ai;
}

describe("explainer quality eval", () => {
  it.each(EVAL_CASES)("$name", async ({ fixture, mutate, expectIssuePath }) => {
    const candidate = structuredClone(fixture.explanation!);
    mutate?.(candidate);
    const result = await attemptGeneration(aiReturning(candidate), "eval-model", materialFor(fixture as typeof first), null);

    if (expectIssuePath === null) {
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.path)).toContain(expectIssuePath);
    }
  });
});
