import { describe, expect, it } from "vitest";
import type { SourceBlock } from "../src/domain/source";
import {
  duplicateWindowStart,
  findDuplicate,
  formatSelectionReason,
  isNearDuplicate,
  scoreSource,
} from "../src/domain/selection";

function blocks(spec: Array<{ kind?: SourceBlock["kind"]; text: string }>): SourceBlock[] {
  return spec.map((block, index) => ({
    id: `b${index + 1}`,
    kind: block.kind ?? "paragraph",
    text: block.text,
    sourceUrl: "https://example.com/post",
    headingPath: [],
  }));
}
function words(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}

describe("source scoring", () => {
  it("generates for a mechanism-heavy post", () => {
    const result = scoreSource({
      title: "How we rebuilt the query planner",
      url: "https://example.com/blog/query-planner",
      wordCount: 1200,
      blocks: blocks([
        { kind: "heading", text: "Why the old planner failed" },
        { kind: "heading", text: "Latency and throughput" },
        { kind: "heading", text: "The cache and index design" },
        { text: "We measured 42% lower latency at 1200 req/s and 35 ms p99." },
        { kind: "code", text: "SELECT * FROM t WHERE id = 1" },
        { kind: "code", text: "EXPLAIN ANALYZE SELECT * FROM t" },
        ...Array.from({ length: 6 }, () => ({ text: words(80) })),
      ]),
    });
    expect(result.decision).toBe("generate");
    expect(result.score).toBeGreaterThanOrEqual(45);
  });

  it("skips a release note with no mechanism evidence", () => {
    const result = scoreSource({
      title: "Introducing Node.js 26.13.0",
      url: "https://example.com/blog/introducing-node-js-26-13-0",
      wordCount: 350,
      blocks: blocks([{ text: words(350) }]),
    });
    expect(result.decision).toBe("skip");
    expect(result.score).toBeLessThan(45);
    expect(result.reasons.join(" ")).toMatch(/release/i);
  });

  it("halves the release-title penalty when the title names a mechanism", () => {
    const result = scoreSource({
      title: "How we redesigned the release pipeline",
      url: "https://example.com/blog/release-pipeline-design",
      wordCount: 1200,
      blocks: blocks([
        { kind: "heading", text: "The old pipeline" },
        { kind: "heading", text: "Queue and cache design" },
        { kind: "heading", text: "Latency results" },
        { text: "We measured 42% lower latency at 1200 req/s and 35 ms p99." },
        { kind: "code", text: "const queue = new Queue()" },
        { kind: "code", text: "await queue.drain()" },
        ...Array.from({ length: 6 }, () => ({ text: words(80) })),
      ]),
    });
    expect(result.decision).toBe("generate");
    expect(result.reasons.join(" ")).toMatch(/release/i);
  });

  it("force-skips docs and archive URLs without a mechanism title", () => {
    const signalRich = blocks([
      { kind: "heading", text: "Request" },
      { kind: "heading", text: "Response" },
      { kind: "heading", text: "Errors" },
      { kind: "code", text: "GET /v1/items" },
      { kind: "code", text: "POST /v1/items" },
      { kind: "code", text: "DELETE /v1/items/:id" },
      ...Array.from({ length: 8 }, () => ({ text: words(100) })),
    ]);
    expect(scoreSource({
      title: "API reference",
      url: "https://example.com/docs/api",
      wordCount: 2000,
      blocks: signalRich,
    }).decision).toBe("skip");
    expect(scoreSource({
      title: "Notes from the team",
      url: "https://example.com/tags/notes",
      wordCount: 2000,
      blocks: signalRich,
    }).decision).toBe("skip");
  });

  it("allows a docs page whose title names a mechanism", () => {
    const result = scoreSource({
      title: "How the scheduler works",
      url: "https://example.com/docs/scheduler",
      wordCount: 1200,
      blocks: blocks([
        { kind: "heading", text: "Queue and latency" },
        { kind: "heading", text: "Retry design" },
        { kind: "heading", text: "Failure handling" },
        { text: "We measured 42% lower latency at 1200 req/s and 35 ms p99." },
        { kind: "code", text: "schedule(task)" },
        { kind: "code", text: "await run(task)" },
        ...Array.from({ length: 6 }, () => ({ text: words(80) })),
      ]),
    });
    expect(result.decision).toBe("generate");
  });

  it("skips podcasts, roundups, promotional pages, and thin posts", () => {
    expect(scoreSource({
      title: "The Changelog Podcast: Episode 42",
      url: "https://example.com/podcast/42",
      wordCount: 500,
      blocks: blocks([{ text: words(500) }]),
    }).decision).toBe("skip");

    expect(scoreSource({
      title: "Weekly roundup: ten links",
      url: "https://example.com/blog/roundup",
      wordCount: 300,
      blocks: blocks([{ text: words(300) }]),
    }).decision).toBe("skip");

    expect(scoreSource({
      title: "The industry-leading platform",
      url: "https://example.com/blog/platform",
      wordCount: 400,
      blocks: blocks([{
        text: "We are excited about this best-in-class, world-class, seamless platform. Unlock what is possible.",
      }]),
    }).decision).toBe("skip");

    expect(scoreSource({
      title: "A short note",
      url: "https://example.com/blog/note",
      wordCount: 300,
      blocks: blocks([{ text: words(300) }]),
    }).decision).toBe("skip");
  });
});

describe("duplicate matching", () => {
  it("treats generic titles as non-duplicates", () => {
    expect(isNearDuplicate("Weekly update", "Weekly update")).toBe(false);
  });

  it("matches same-source near-duplicate titles", () => {
    expect(isNearDuplicate(
      "Introducing the Vercel AI SDK 5",
      "Vercel AI SDK 5 is now available",
    )).toBe(true);
    expect(isNearDuplicate("Vercel AI SDK 5", "Vercel edge runtime")).toBe(false);
  });

  it("returns the earliest duplicate candidate", () => {
    const duplicate = findDuplicate("Vercel AI SDK 5", [
      { id: "new", originalTitle: "Vercel AI SDK 5 is now available", slug: "new", publishedAt: "2026-10-28T00:00:00.000Z" },
      { id: "old", originalTitle: "Introducing the Vercel AI SDK 5", slug: "old", publishedAt: "2026-10-27T00:00:00.000Z" },
    ]);
    expect(duplicate?.id).toBe("old");
  });

  it("computes the duplicate window start", () => {
    expect(duplicateWindowStart("2026-10-29T12:00:00.000Z")).toBe("2026-10-15T12:00:00.000Z");
    expect(formatSelectionReason(["a", "b", "c", "d"])).toBe("a; b; c");
    expect(formatSelectionReason(["x".repeat(600)])).toHaveLength(500);
  });
});
