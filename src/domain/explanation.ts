import { z } from "zod";

/**
 * An inline run of text. A run may carry one citation or one code span.
 * Generated content may not carry arbitrary links: sources own URLs.
 */
export const inlineSchema = z.object({
  text: z.string().min(1).max(1200),
  cite: z.string().min(1).max(24).optional(),
  code: z.boolean().optional(),
  strong: z.boolean().optional(),
  em: z.boolean().optional(),
});

export type Inline = z.infer<typeof inlineSchema>;

export const blockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("p"),
    runs: z.array(inlineSchema).min(1).max(40),
  }),
  z.object({
    type: z.literal("list"),
    ordered: z.boolean().optional(),
    items: z.array(z.array(inlineSchema).min(1).max(20)).min(1).max(12),
  }),
  z.object({
    type: z.literal("code"),
    language: z.string().min(1).max(24),
    code: z.string().min(1).max(4000),
    caption: z.string().max(240).optional(),
  }),
  z.object({
    type: z.literal("quote"),
    runs: z.array(inlineSchema).min(1).max(40),
    attribution: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("note"),
    tone: z.enum(["note", "warning"]),
    title: z.string().min(1).max(120),
    runs: z.array(inlineSchema).min(1).max(40),
  }),
]);

export type Block = z.infer<typeof blockSchema>;

export const sectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48),
  title: z.string().min(2).max(90),
  blocks: z.array(blockSchema).min(1).max(14),
});

export type Section = z.infer<typeof sectionSchema>;

export const diagramNodeSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(32),
  label: z.string().min(1).max(44),
  detail: z.string().max(140).optional(),
  cite: z.string().max(24).optional(),
});

export const diagramEdgeSchema = z.object({
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
  label: z.string().max(44).optional(),
  cite: z.string().max(24).optional(),
});

export const diagramSchema = z.object({
  kind: z.enum(["flow", "sequence"]),
  title: z.string().min(3).max(100),
  description: z.string().min(20).max(400),
  conceptual: z.boolean(),
  nodes: z.array(diagramNodeSchema).min(2).max(10),
  edges: z.array(diagramEdgeSchema).max(16),
  caption: z.string().max(260).optional(),
});

export type Diagram = z.infer<typeof diagramSchema>;
export type DiagramNode = z.infer<typeof diagramNodeSchema>;
export type DiagramEdge = z.infer<typeof diagramEdgeSchema>;

export const sourceRefSchema = z.object({
  id: z.string().regex(/^s[0-9]{1,2}$/),
  label: z.string().min(2).max(180),
  url: z.string().url().max(600),
  note: z.string().max(240).optional(),
  evidenceIds: z.array(z.string().min(1).max(40)).max(12).optional(),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;

export const tradeoffSchema = z.object({
  title: z.string().min(2).max(80),
  body: z.string().min(10).max(420),
});

export const eli5Schema = z.object({
  body: z.array(blockSchema).min(1).max(6),
  limit: z.string().min(10).max(280),
});

export const explanationSchema = z.object({
  schemaVersion: z.literal("1"),
  contextHeadline: z.string().min(12).max(90),
  dek: z.string().min(20).max(220),
  oneSentence: z.string().min(20).max(180),
  tldr: z.array(z.string().min(12).max(320)).min(2).max(5),
  sections: z.array(sectionSchema).min(2).max(7),
  diagram: diagramSchema,
  eli5: eli5Schema,
  tradeoffs: z.array(tradeoffSchema).min(1).max(5),
  whenUseful: z.array(z.string().min(12).max(260)).min(1).max(5),
  caveats: z.array(z.string().min(8).max(300)).max(5),
  sources: z.array(sourceRefSchema).min(1).max(8),
  readingMinutes: z.number().int().min(1).max(40),
  topic: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40),
  publishedAt: z.string().datetime().optional(),
});

export type Explanation = z.infer<typeof explanationSchema>;

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; value: Explanation }
  | { ok: false; issues: ValidationIssue[] };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Structural and semantic validation. This is deliberately stricter than
 * "the JSON parsed": a citation that points nowhere is a publishing bug.
 */
export function validateExplanation(input: unknown): ValidationResult {
  const parsed = explanationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }

  const value = parsed.data;
  const issues: ValidationIssue[] = [];
  const sourceIds = new Set<string>();

  for (const [index, source] of value.sources.entries()) {
    if (sourceIds.has(source.id)) {
      issues.push({ path: `sources.${index}.id`, message: `Duplicate source id ${source.id}` });
    }
    sourceIds.add(source.id);
    if (!isHttpUrl(source.url)) {
      issues.push({ path: `sources.${index}.url`, message: "Source URL must be http(s)" });
    }
  }

  const sectionIds = new Set<string>();
  for (const [index, section] of value.sections.entries()) {
    if (sectionIds.has(section.id)) {
      issues.push({ path: `sections.${index}.id`, message: `Duplicate section id ${section.id}` });
    }
    sectionIds.add(section.id);
    for (const [blockIndex, block] of section.blocks.entries()) {
      checkBlock(block, `sections.${index}.blocks.${blockIndex}`, sourceIds, issues);
    }
  }

  for (const [index, block] of value.eli5.body.entries()) {
    checkBlock(block, `eli5.body.${index}`, sourceIds, issues);
  }

  const nodeIds = new Set<string>();
  for (const [index, node] of value.diagram.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      issues.push({ path: `diagram.nodes.${index}.id`, message: `Duplicate node id ${node.id}` });
    }
    nodeIds.add(node.id);
    if (node.cite && !sourceIds.has(node.cite)) {
      issues.push({
        path: `diagram.nodes.${index}.cite`,
        message: `Unknown citation ${node.cite}`,
      });
    }
  }

  for (const [index, edge] of value.diagram.edges.entries()) {
    if (!nodeIds.has(edge.from)) {
      issues.push({ path: `diagram.edges.${index}.from`, message: `Unknown node ${edge.from}` });
    }
    if (!nodeIds.has(edge.to)) {
      issues.push({ path: `diagram.edges.${index}.to`, message: `Unknown node ${edge.to}` });
    }
    if (edge.from === edge.to) {
      issues.push({ path: `diagram.edges.${index}`, message: "Self-edges are not supported" });
    }
    if (edge.cite && !sourceIds.has(edge.cite)) {
      issues.push({
        path: `diagram.edges.${index}.cite`,
        message: `Unknown citation ${edge.cite}`,
      });
    }
  }

  if (value.diagram.kind === "sequence" && value.diagram.edges.length === 0) {
    issues.push({ path: "diagram.edges", message: "A sequence needs at least one message" });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function checkBlock(block: Block, path: string, sourceIds: Set<string>, issues: ValidationIssue[]): void {
  const runs =
    block.type === "list"
      ? block.items.flat()
      : block.type === "code"
        ? []
        : block.runs;

  for (const [index, run] of runs.entries()) {
    if (run.cite && !sourceIds.has(run.cite)) {
      issues.push({ path: `${path}.runs.${index}.cite`, message: `Unknown citation ${run.cite}` });
    }
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function countWords(explanation: Explanation): number {
  const text: string[] = [
    explanation.contextHeadline,
    explanation.dek,
    explanation.oneSentence,
    ...explanation.tldr,
  ];

  for (const section of explanation.sections) {
    for (const block of section.blocks) {
      text.push(...blockText(block));
    }
  }

  for (const block of explanation.eli5.body) text.push(...blockText(block));
  text.push(explanation.eli5.limit);
  for (const tradeoff of explanation.tradeoffs) text.push(tradeoff.title, tradeoff.body);
  text.push(...explanation.whenUseful, ...explanation.caveats);

  return text.join(" ").trim().split(/\s+/).filter(Boolean).length;
}

function blockText(block: Block): string[] {
  switch (block.type) {
    case "code":
      return [block.code, block.caption ?? ""];
    case "list":
      return block.items.flat().map((run) => run.text);
    case "p":
      return block.runs.map((run) => run.text);
    case "quote":
      return [...block.runs.map((run) => run.text), block.attribution ?? ""];
    case "note":
      return [block.title, ...block.runs.map((run) => run.text)];
  }
}

export function isSafeSlug(value: string): boolean {
  return SLUG.test(value);
}
