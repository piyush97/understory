import { TOPIC_SEEDS } from "../content/topics";
import type { SourceSnapshot } from "../domain/source";

export const PROMPT_VERSION = "explain-1";
export const SCHEMA_VERSION = "1";

export type GenerationMaterial = {
  articleTitle: string;
  articleUrl: string;
  articlePublishedAt: string;
  sourceName: string;
  snapshot: SourceSnapshot;
  links: Array<{ url: string; host: string }>;
};

const SYSTEM_PROMPT = `You are the explainer desk for Understory, a reading app for working engineers.

Your job is to explain one engineering blog post so a staff engineer at a different company can use it in their own work. Lead with the mechanism, not the announcement. Prefer concrete numbers, interfaces, failure modes, and costs. Treat vendor benchmarks as claims, not facts.

Hard rules:
- Every factual claim must come from the source material below or from well-established public knowledge.
- Never invent URLs, numbers, quotes, benchmarks, or people.
- Never copy a sentence longer than twelve words from the source. Paraphrase.
- If the source is thin or promotional, say so in caveats instead of filling the gap with guesses.
- Output one JSON object and nothing else. No markdown fences, no commentary.`;

export function buildGenerationMessages(material: GenerationMaterial): Array<{
  role: "system" | "user";
  content: string;
}> {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(material) },
  ];
}

export function buildUserPrompt(material: GenerationMaterial): string {
  const blocks = selectBlocks(material.snapshot.blocks);
  const excerpt = blocks
    .map((block) => {
      const path = block.headingPath.length > 0 ? ` [${block.headingPath.join(" > ")}]` : "";
      const text = block.kind === "code" ? indentCode(block.text) : block.text;
      return `[${block.id}] (${block.kind})${path}\n${text}`;
    })
    .join("\n\n");

  const linkLines = material.links
    .filter((link) => link.url !== material.articleUrl)
    .slice(0, 12)
    .map((link) => `- ${link.host}: ${link.url}`)
    .join("\n");

  const topicLines = TOPIC_SEEDS.map((topic) => `${topic.id} (${topic.label})`).join(", ");

  return `ARTICLE
Title: ${material.articleTitle}
URL: ${material.articleUrl}
Published: ${material.articlePublishedAt}
Source: ${material.sourceName}

SOURCE EXCERPT
Blocks are prefixed with an id you can cite in evidenceIds. Claim numbers, quoted phrases, and contested statements must point at a block id or a source url below.

${excerpt || "(The extractor found no usable prose. Report this in caveats and keep claims minimal.)"}

LINKS FOUND ON THE PAGE
${linkLines || "(none)"}

ALLOWED SOURCE URLS
- ${material.articleUrl} (source s1, the original article)
${material.links
  .filter((link) => link.url !== material.articleUrl)
  .slice(0, 12)
  .map((link) => `- ${link.url} (${link.host})`)
  .join("\n")}

Allowed topics: ${topicLines}

OUTPUT SHAPE
{
  "schemaVersion": "1",
  "contextHeadline": "string, 12-90 chars, states the engineering substance",
  "dek": "string, 20-220 chars, one sentence for the feed",
  "oneSentence": "string, 20-180 chars, what changed and why it matters",
  "tldr": ["3-5 bullets, each 12-320 chars, concrete and specific"],
  "sections": [
    {
      "id": "kebab-case-id",
      "title": "section title",
      "blocks": [
        { "type": "p", "runs": [{ "text": "prose", "cite": "s1" }] },
        { "type": "list", "items": [[{ "text": "item" }], [{ "text": "item" }]] },
        { "type": "code", "language": "bash", "code": "real command", "caption": "optional" },
        { "type": "quote", "runs": [{ "text": "short quote", "cite": "s1" }], "attribution": "optional" },
        { "type": "note", "tone": "warning", "title": "short label", "runs": [{ "text": "caveat" }] }
      ]
    }
  ],
  "diagram": {
    "kind": "flow",
    "title": "string, 3-100 chars",
    "description": "string, 20-400 chars, what the diagram shows",
    "conceptual": true,
    "nodes": [{ "id": "node-id", "label": "short label", "detail": "optional", "cite": "s1" }],
    "edges": [{ "from": "node-id", "to": "node-id", "label": "optional", "cite": "s1" }],
    "caption": "optional"
  },
  "eli5": {
    "body": [{ "type": "p", "runs": [{ "text": "plain-language explanation" }] }],
    "limit": "one sentence about where the analogy stops working"
  },
  "tradeoffs": [{ "title": "short label", "body": "what is gained and what is paid" }],
  "whenUseful": ["short statement"],
  "caveats": ["short statement"],
  "sources": [
    {
      "id": "s1",
      "label": "Original article title",
      "url": "${material.articleUrl}",
      "note": "optional context",
      "evidenceIds": ["b1", "b4"]
    }
  ],
  "readingMinutes": 5,
  "topic": "one id from the allowed list"
}

REQUIREMENTS
1. sections: 3 to 6. Include one section on the problem and context, one on how the mechanism works, and one on evidence, limits, or operational consequences.
2. Each section has 2 to 8 blocks. Vary paragraph, list, code, quote, and note where they help.
3. Inline runs carry text plus at most one of cite, code, strong, em. cite must be a source id such as s1. Do not place markdown inside text.
4. diagram: 3 to 7 nodes, 2 to 9 edges. Node and edge ids are kebab-case. A sequence diagram reads top to bottom. Set conceptual to false only when every node and edge appears explicitly in the source.
5. sources: 2 to 4, starting with s1 for the original article. Only use the allowed source urls. evidenceIds must be block ids from the excerpt.
6. eli5: 1 to 2 blocks, short sentences, no unexplained jargon. limit is exactly one sentence.
7. tradeoffs: 2 to 4. whenUseful: 2 to 4. caveats: 1 to 3.
8. topic: exactly one id from the allowed list.
9. Prose: no em dashes, no en dashes, no rhetorical questions, no "not just X but Y", no "in conclusion", no marketing superlatives, no bolded label fragments, no bullet that is only a label. Use plain verbs and specific nouns. Vary sentence length.
10. Do not repeat the same point in the dek, oneSentence, and tldr. Each piece of the summary adds a different fact.

Return the JSON object now.`;
}

function selectBlocks(blocks: SourceSnapshot["blocks"], budget = 22_000): SourceSnapshot["blocks"] {
  const preferred = blocks.filter((block) => block.kind !== "caption");
  const selected: SourceSnapshot["blocks"] = [];
  let remaining = budget;

  for (const block of preferred) {
    const cost = block.text.length + 40;
    if (cost > remaining) {
      if (block.kind === "heading" || block.kind === "paragraph") {
        const trimmed = { ...block, text: block.text.slice(0, Math.max(0, remaining - 40)) };
        if (trimmed.text.length > 80) selected.push(trimmed);
      }
      break;
    }
    selected.push(block);
    remaining -= cost;
  }

  if (selected.length === 0) return blocks.slice(0, 12);
  return selected;
}

function indentCode(code: string): string {
  return code
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
