import { TOPIC_IDS } from "../content/topics";
import {
  validateExplanation,
  type Block,
  type Explanation,
  type ValidationIssue,
} from "../domain/explanation";
import { buildGenerationMessages, type GenerationMaterial } from "./prompt";

export type GenerationAttempt = {
  ok: boolean;
  explanation: Explanation | null;
  issues: ValidationIssue[];
  rawText: string;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
};

export async function attemptGeneration(
  ai: Ai,
  model: string,
  material: GenerationMaterial,
  previous: { rawText: string; issues: ValidationIssue[] } | null,
): Promise<GenerationAttempt> {
  const messages = buildGenerationMessages(material);
  if (previous) {
    messages.push({
      role: "user",
      content: `The previous attempt was rejected by the editor. Fix every issue and return the corrected JSON object only. Do not add commentary.\n\nIssues:\n${previous.issues
        .slice(0, 24)
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n")}\n\nPrevious output:\n${previous.rawText.slice(0, 8_000)}`,
    });
  }

  const response = (await ai.run(model, {
    messages,
    max_tokens: 4_096,
    temperature: 0.35,
  })) as {
    response?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const rawText = response.response ?? "";
  const parsed = extractJsonObject(rawText);
  if (!parsed) {
    return {
      ok: false,
      explanation: null,
      issues: [{ path: "(root)", message: "Model did not return a parseable JSON object" }],
      rawText,
      usage: tokenUsage(response),
    };
  }

  const validation = validateExplanation(parsed);
  if (!validation.ok) {
    return { ok: false, explanation: null, issues: validation.issues, rawText, usage: tokenUsage(response) };
  }

  const semanticIssues = checkEditorialRules(validation.value, material);
  if (semanticIssues.length > 0) {
    return { ok: false, explanation: null, issues: semanticIssues, rawText, usage: tokenUsage(response) };
  }

  return {
    ok: true,
    explanation: finalizeExplanation(validation.value),
    issues: [],
    rawText,
    usage: tokenUsage(response),
  };
}

export function checkEditorialRules(
  explanation: Explanation,
  material: GenerationMaterial,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowedUrls = new Set([material.articleUrl, ...material.links.map((link) => link.url)]);
  const topicIds = new Set(TOPIC_IDS);

  const firstSource = explanation.sources[0];
  if (!firstSource || firstSource.url !== material.articleUrl) {
    issues.push({
      path: "sources.0.url",
      message: "s1 must be the original article URL",
    });
  }
  if (firstSource && firstSource.id !== "s1") {
    issues.push({ path: "sources.0.id", message: "The original article must use source id s1" });
  }

  const blockIds = new Set(material.snapshot.blocks.map((block) => block.id));
  for (const [index, source] of explanation.sources.entries()) {
    for (const evidenceId of source.evidenceIds ?? []) {
      if (!blockIds.has(evidenceId)) {
        issues.push({
          path: `sources.${index}.evidenceIds`,
          message: `Evidence id ${evidenceId} was not in the source excerpt`,
        });
      }
    }
  }

  for (const [index, source] of explanation.sources.entries()) {
    if (!allowedUrls.has(source.url)) {
      issues.push({
        path: `sources.${index}.url`,
        message: `Source URL was not in the provided material: ${source.url}`,
      });
    }
  }

  if (!topicIds.has(explanation.topic)) {
    issues.push({ path: "topic", message: `Topic ${explanation.topic} is not in the allowed list` });
  }

  if (explanation.sections.length < 3) {
    issues.push({ path: "sections", message: "Use at least three sections" });
  }

  if (explanation.tldr.length < 3) {
    issues.push({ path: "tldr", message: "Use at least three TL;DR bullets" });
  }

  return issues;
}

export function finalizeExplanation(explanation: Explanation): Explanation {
  const words = countWords(explanation);
  const readingMinutes = Math.max(2, Math.min(20, Math.round(words / 230)));
  return { ...explanation, readingMinutes };
}

export function countWords(explanation: Explanation): number {
  const chunks: string[] = [];
  for (const section of explanation.sections) {
    for (const block of section.blocks) collectBlockText(block, chunks);
  }
  for (const block of explanation.eli5.body) collectBlockText(block, chunks);
  chunks.push(explanation.dek, explanation.oneSentence, ...explanation.tldr);
  return Math.max(
    1,
    chunks
      .join(" ")
      .split(/\s+/)
      .filter(Boolean).length,
  );
}

function collectBlockText(block: Block, chunks: string[]): void {
  switch (block.type) {
    case "p":
    case "quote":
      chunks.push(block.runs.map((run) => run.text).join(" "));
      break;
    case "list":
      for (const item of block.items) chunks.push(item.map((run) => run.text).join(" "));
      break;
    case "code":
      chunks.push(block.code);
      break;
    case "note":
      chunks.push(block.runs.map((run) => run.text).join(" "));
      break;
  }
}

export function extractJsonObject(raw: string): unknown {
  const withoutFences = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tokenUsage(response: {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}): { inputTokens: number | null; outputTokens: number | null } | null {
  if (!response.usage) return null;
  return {
    inputTokens: response.usage.prompt_tokens ?? null,
    outputTokens: response.usage.completion_tokens ?? null,
  };
}
