import { validateExplanation, type Explanation } from "../../domain/explanation";

export type Provenance = {
  origin?: string;
  modelId?: string;
  promptVersion?: string;
  schemaVersion?: string;
  generatedAt?: string;
  reviewedBy?: string;
  sourceSnapshotId?: string;
  attempts?: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    neurons?: number;
  };
};

export function parseExplanation(value: string): Explanation | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = validateExplanation(parsed);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

export function parseProvenance(value: string | null | undefined): Provenance {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Provenance) : {};
  } catch {
    return {};
  }
}
