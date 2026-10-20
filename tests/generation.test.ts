import { describe, expect, it } from "vitest";
import { FIXTURE_ARTICLES } from "../src/content/fixtures";
import type { Explanation } from "../src/domain/explanation";
import {
  checkEditorialRules,
  countWords,
  extractJsonObject,
  finalizeExplanation,
  attemptGeneration,
} from "../src/pipeline/generate";
import { dailyNeuronBudget } from "../src/shared/env";
import { buildGenerationMessages, type GenerationMaterial } from "../src/pipeline/prompt";

const published = FIXTURE_ARTICLES.filter((fixture) => fixture.article.status === "published");
const fixture = published[0];
const explanation = fixture?.explanation as Explanation;

const material: GenerationMaterial = {
  articleTitle: fixture?.article.originalTitle ?? "Example",
  articleUrl: fixture?.article.canonicalUrl ?? "https://example.com/post",
  articlePublishedAt: fixture?.article.publishedAt ?? "2026-10-19T00:00:00.000Z",
  sourceName: fixture?.source.name ?? "Example",
  snapshot: {
    articleId: fixture?.article.id ?? "art_example",
    title: fixture?.article.originalTitle ?? "Example",
    url: fixture?.article.canonicalUrl ?? "https://example.com/post",
    fetchedAt: "2026-10-19T00:00:00.000Z",
    extractorVersion: "test",
    wordCount: 100,
    blocks: fixture?.snapshot?.blocks ?? [
      {
        id: "b1",
        kind: "paragraph",
        text: "Example material.",
        sourceUrl: "https://example.com/post",
        headingPath: [],
      },
    ],
  },
  links: [
    { url: "https://example.com/docs", host: "example.com" },
    {
      url: "https://docs.claude.com/en/docs/build-with-claude/prompt-caching",
      host: "docs.claude.com",
    },
    { url: "https://blog.cloudflare.com/ai-code-review/", host: "blog.cloudflare.com" },
  ],
};

describe("model output handling", () => {
  it("parses a plain JSON object, fenced JSON, and leading commentary", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go:\n{"a":1}\nDone.')).toEqual({ a: 1 });
  });

  it("returns null for truncated or non-object output", () => {
    expect(extractJsonObject('{"a":')).toBeNull();
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[]")).toBeNull();
  });

  it("recomputes reading time from the final prose", () => {
    const finalized = finalizeExplanation({ ...explanation, readingMinutes: 40 });
    expect(finalized.readingMinutes).toBe(
      Math.max(2, Math.min(20, Math.round(countWords(explanation) / 230))),
    );
  });
});

describe("editorial checks", () => {
  it("accepts a reviewed explanation written for its source", () => {
    expect(checkEditorialRules(explanation, material)).toEqual([]);
  });

  it("rejects a source url the pipeline did not provide", () => {
    const broken = structuredClone(explanation);
    const source = broken.sources[0];
    if (!source) throw new Error("fixture shape changed");
    source.url = "https://invented.example/paper";
    const issues = checkEditorialRules(broken, material);
    expect(issues.some((issue) => issue.path.startsWith("sources.0"))).toBe(true);
  });

  it("requires s1 to be the original article", () => {
    const broken = structuredClone(explanation);
    const source = broken.sources[0];
    if (!source) throw new Error("fixture shape changed");
    source.url = material.links[0]?.url ?? "https://example.com/docs";
    const issues = checkEditorialRules(broken, material);
    expect(issues.some((issue) => issue.message.includes("original article"))).toBe(true);
  });

  it("rejects an unknown topic", () => {
    const issues = checkEditorialRules({ ...explanation, topic: "not-a-topic" }, material);
    expect(issues.some((issue) => issue.path === "topic")).toBe(true);
  });

  it("rejects invented evidence block ids", () => {
    const broken = structuredClone(explanation);
    const source = broken.sources[0];
    if (!source) throw new Error("fixture shape changed");
    source.evidenceIds = ["b999"];
    const issues = checkEditorialRules(broken, material);
    expect(issues.some((issue) => issue.path === "sources.0.evidenceIds")).toBe(true);
  });
});

describe("prompt construction", () => {
  it("includes source block ids, the canonical url, and the allowed topic list", () => {
    const messages = buildGenerationMessages(material);
    expect(messages).toHaveLength(2);
    const user = messages[1]?.content ?? "";
    expect(user).toContain(material.articleUrl);
    expect(user).toContain(`[${material.snapshot.blocks[0]?.id}]`);
    expect(user).toContain("ai-infrastructure");
    expect(user).toContain("Only use the allowed source urls");
  });
});

describe("model calls", () => {
  it("accepts a valid JSON response and reports token usage", async () => {
    const ai = {
      run: async () => ({
        response: JSON.stringify(explanation),
        usage: { prompt_tokens: 1200, completion_tokens: 800 },
      }),
    } as unknown as Ai;

    const result = await attemptGeneration(ai, "test-model", material, null);
    expect(result.ok).toBe(true);
    expect(result.explanation?.contextHeadline).toBe(explanation.contextHeadline);
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 800 });
  });

  it("rejects malformed model output without throwing", async () => {
    const ai = {
      run: async () => ({ response: '{"contextHeadline": "short"' }),
    } as unknown as Ai;
    const result = await attemptGeneration(ai, "test-model", material, null);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/parseable JSON/);
  });

  it("reserves zero as a valid budget kill switch", () => {
    expect(dailyNeuronBudget("0")).toBe(0);
    expect(dailyNeuronBudget("12000")).toBe(9000);
    expect(dailyNeuronBudget("not-a-number")).toBe(8000);
  });
});
