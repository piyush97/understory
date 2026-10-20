import { TOPIC_IDS } from "../content/topics";
import {
  explanationSchema,
  validateExplanation,
  type Block,
  type Explanation,
  type ValidationIssue,
} from "../domain/explanation";
import { buildGenerationMessages, type GenerationMaterial } from "./prompt";

const EXPLANATION_JSON_SCHEMA = explanationSchema.toJSONSchema();

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
    max_tokens: 8_192,
    temperature: 0.35,
    response_format: { type: "json_schema", json_schema: EXPLANATION_JSON_SCHEMA },
  })) as unknown;

  const output = readModelOutput(response);
  const rawText = output.text;
  if (rawText.trim().length === 0) {
    return {
      ok: false,
      explanation: null,
      issues: [{ path: "(root)", message: emptyOutputMessage(output) }],
      rawText,
      usage: toTokenUsage(output.usage),
    };
  }

  const parsed = extractJsonObject(rawText);
  if (!parsed) {
    return {
      ok: false,
      explanation: null,
      issues: withFinishIssue(
        [{ path: "(root)", message: "Model did not return a parseable JSON object" }],
        output.finishReason,
      ),
      rawText,
      usage: toTokenUsage(output.usage),
    };
  }

  const validation = validateExplanation(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      explanation: null,
      issues: withFinishIssue(validation.issues, output.finishReason),
      rawText,
      usage: toTokenUsage(output.usage),
    };
  }

  const semanticIssues = checkEditorialRules(validation.value, material);
  if (semanticIssues.length > 0) {
    return {
      ok: false,
      explanation: null,
      issues: semanticIssues,
      rawText,
      usage: toTokenUsage(output.usage),
    };
  }

  return {
    ok: true,
    explanation: finalizeExplanation(validation.value),
    issues: [],
    rawText,
    usage: toTokenUsage(output.usage),
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

type ModelUsage = { prompt_tokens?: number; completion_tokens?: number };

type ModelOutput = {
  text: string;
  reasoning: string;
  finishReason: string | null;
  usage: ModelUsage | null;
};

function emptyModelOutput(): ModelOutput {
  return { text: "", reasoning: "", finishReason: null, usage: null };
}

function readModelOutput(value: unknown, depth = 0): ModelOutput {
  if (typeof value === "string") {
    return { text: value, reasoning: "", finishReason: null, usage: null };
  }
  if (depth > 6) return emptyModelOutput();

  const record = asRecord(value);
  if (!record) return emptyModelOutput();

  const usage = readUsage(record.usage);
  const finishReason = firstString(record.finish_reason, record.stop_reason);

  if (typeof record.response === "string") {
    return { text: record.response, reasoning: "", finishReason, usage };
  }

  if (Array.isArray(record.choices)) {
    let reasoning = "";
    let choiceFinishReason = finishReason;
    for (const choice of record.choices) {
      const choiceRecord = asRecord(choice);
      if (!choiceRecord) continue;
      choiceFinishReason = firstString(choiceRecord.finish_reason, choiceFinishReason);

      const message = asRecord(choiceRecord.message);
      if (message) {
        const reasoningText = firstString(message.reasoning_content, message.reasoning);
        if (reasoningText) reasoning = reasoningText;
        const text = contentText(message.content);
        if (text.trim()) {
          return { text, reasoning, finishReason: choiceFinishReason, usage };
        }
      }

      const completionText = contentText(choiceRecord.text);
      if (completionText.trim()) {
        return { text: completionText, reasoning, finishReason: choiceFinishReason, usage };
      }
    }
    return { text: "", reasoning, finishReason: choiceFinishReason, usage };
  }

  const nestedMessage = asRecord(record.message);
  if (nestedMessage) {
    const reasoning = firstString(nestedMessage.reasoning_content, nestedMessage.reasoning);
    const text = contentText(nestedMessage.content);
    if (text.trim()) {
      return { text, reasoning, finishReason, usage };
    }
    return { text: "", reasoning, finishReason, usage };
  }

  if (isRecord(record.response)) {
    const nested = readModelOutput(record.response, depth + 1);
    const mergedUsage = usage ?? nested.usage;
    if (nested.text.trim() || nested.reasoning) {
      return { ...nested, usage: mergedUsage };
    }
    if (!looksLikeEnvelope(record.response)) {
      return {
        text: JSON.stringify(record.response),
        reasoning: "",
        finishReason,
        usage: mergedUsage,
      };
    }
    return { text: "", reasoning: nested.reasoning, finishReason: nested.finishReason, usage: mergedUsage };
  }

  if (typeof record.text === "string") {
    return { text: record.text, reasoning: "", finishReason, usage };
  }

  return { text: "", reasoning: "", finishReason, usage };
}

function looksLikeEnvelope(value: Record<string, unknown>): boolean {
  return "choices" in value || "message" in value || "response" in value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        const partRecord = asRecord(part);
        return partRecord && typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .join("");
  }
  const record = asRecord(value);
  return record && typeof record.text === "string" ? record.text : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function readUsage(value: unknown): ModelUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const promptTokens = typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined;
  const completionTokens =
    typeof record.completion_tokens === "number" ? record.completion_tokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return null;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens };
}

function withFinishIssue(issues: ValidationIssue[], finishReason: string | null): ValidationIssue[] {
  if (finishReason !== "length") return issues;
  return [
    {
      path: "(root)",
      message: "Model output hit the token limit before the JSON was complete; retry with a larger max_tokens.",
    },
    ...issues,
  ];
}

function emptyOutputMessage(output: ModelOutput): string {
  if (output.reasoning.trim().length > 0) {
    return "Model spent its output budget on reasoning before returning JSON; increase max_tokens or disable reasoning.";
  }
  if (output.finishReason === "length") {
    return "Model output was truncated before returning JSON; increase max_tokens.";
  }
  return "Model did not return any text.";
}

function toTokenUsage(
  usage: ModelUsage | null,
): { inputTokens: number | null; outputTokens: number | null } | null {
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
  };
}
