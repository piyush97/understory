import { describe, expect, it } from "vitest";
import {
  articleIdFromUrl,
  canonicalizeUrl,
  estimateReadingMinutes,
  hostOf,
  sha256Hex,
  slugify,
} from "../src/domain/source";
import { decodeCursor, encodeCursor } from "../src/domain/pagination";
import {
  countWords,
  validateExplanation,
  type Explanation,
} from "../src/domain/explanation";
import { renderDiagramSvg } from "../src/domain/diagram";
import { FIXTURE_ARTICLES } from "../src/content/fixtures";

const published = FIXTURE_ARTICLES.filter((fixture) => fixture.article.status === "published");
const explanation = published[0]?.explanation as Explanation;

describe("canonical URLs", () => {
  it("drops tracking params, sorts the rest, and removes a trailing slash", () => {
    const url = canonicalizeUrl(
      "https://Example.com/Post/?utm_source=x&b=2&a=1&fbclid=abc#section",
    );
    expect(url).toBe("https://example.com/Post?a=1&b=2");
  });

  it("preserves unknown query parameters because publishers use them as ids", () => {
    expect(canonicalizeUrl("https://example.com/post?p=123")).toBe(
      "https://example.com/post?p=123",
    );
  });

  it("removes default ports and lowercases the host", () => {
    expect(canonicalizeUrl("HTTPS://WWW.Example.COM:443/a/")).toBe(
      "https://www.example.com/a",
    );
    expect(hostOf("https://www.Example.com/a")).toBe("example.com");
  });

  it("rejects non-http protocols", () => {
    expect(() => canonicalizeUrl("javascript:alert(1)")).toThrow();
    expect(() => canonicalizeUrl("mailto:hello@example.com")).toThrow();
  });
});

describe("article identity", () => {
  it("creates a stable prefixed sha256 id", async () => {
    const first = await articleIdFromUrl("https://example.com/a");
    const second = await articleIdFromUrl("https://example.com/a");
    expect(first).toBe(second);
    expect(first).toMatch(/^art_[0-9a-f]{24}$/);
    expect(await sha256Hex("x")).toHaveLength(64);
  });

  it("slugifies punctuation, accents, and long titles", () => {
    expect(slugify("Café Systems: A Field Guide")).toBe("cafe-systems-a-field-guide");
    expect(slugify("  ***  ")).toBe("untitled");
    expect(slugify("a".repeat(100), 16)).toHaveLength(16);
  });

  it("estimates reading time with a one-minute floor", () => {
    expect(estimateReadingMinutes(10)).toBe(1);
    expect(estimateReadingMinutes(460)).toBe(2);
  });
});

describe("feed cursors", () => {
  it("round-trips publishedAt and id", () => {
    const cursor = { publishedAt: "2026-10-19T18:00:00.000Z", id: "art_123" };
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it("treats malformed cursors as the first page", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("not a cursor")).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ id: "x" })))).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ publishedAt: "nope", id: "x" })))).toBeNull();
  });
});

describe("explanation validation", () => {
  it("accepts every reviewed fixture", () => {
    for (const fixture of published) {
      const result = validateExplanation(fixture.explanation);
      expect(result.ok, fixture.article.slug).toBe(true);
    }
  });

  it("rejects a citation that points at no source", () => {
    const broken = structuredClone(explanation);
    const firstSection = broken.sections[0];
    const firstBlock = firstSection?.blocks[0];
    if (!firstBlock || firstBlock.type !== "p") throw new Error("fixture shape changed");
    const firstRun = firstBlock.runs[0];
    if (!firstRun) throw new Error("fixture shape changed");
    firstRun.cite = "s99";

    const result = validateExplanation(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("s99"))).toBe(true);
    }
  });

  it("rejects duplicate section ids and dangling diagram nodes", () => {
    const broken = structuredClone(explanation);
    const firstSection = broken.sections[0];
    if (!firstSection) throw new Error("fixture shape changed");
    broken.sections.push(structuredClone(firstSection));
    broken.diagram.edges.push({ from: "missing-node", to: broken.diagram.nodes[0]?.id ?? "x" });

    const result = validateExplanation(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("Duplicate section id"))).toBe(
        true,
      );
      expect(result.issues.some((issue) => issue.message.includes("Unknown node"))).toBe(true);
    }
  });

  it("counts prose consistently across block types", () => {
    expect(countWords(explanation)).toBeGreaterThan(500);
  });
});

describe("diagram rendering", () => {
  it("renders deterministic SVG with accessible title and every node", () => {
    const diagram = explanation.diagram;
    const first = renderDiagramSvg(diagram);
    const second = renderDiagramSvg(diagram);

    expect(first).toBe(second);
    expect(first.startsWith("<svg")).toBe(true);
    expect(first).toContain('role="img"');
    expect(first).toContain("<title");
    for (const node of diagram.nodes) {
      expect(first).toContain(`data-node="${node.id}"`);
    }
  });

  it("escapes labels instead of allowing markup injection", () => {
    const diagram = explanation.diagram;
    const svg = renderDiagramSvg({
      ...diagram,
      title: "<script>alert(1)</script>",
      nodes: [{ id: "safe", label: "<img src=x onerror=alert(1)>", detail: "&" }],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<img");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("renders a sequence diagram with actor lanes", () => {
    const svg = renderDiagramSvg({
      kind: "sequence",
      title: "Request path",
      description: "A client asks a coordinator, which asks two workers.",
      conceptual: true,
      nodes: [
        { id: "client", label: "Client" },
        { id: "coordinator", label: "Coordinator" },
        { id: "worker", label: "Worker" },
      ],
      edges: [
        { from: "client", to: "coordinator", label: "request" },
        { from: "coordinator", to: "worker", label: "dispatch" },
        { from: "worker", to: "client", label: "result" },
      ],
    });
    expect(svg).toContain("dg-actors");
    expect(svg).toContain("dg-messages");
    expect(svg).toContain("request");
  });
});
