import type { SiteState } from "../infrastructure/db";

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  PIPELINE_QUEUE: Queue<QueueMessage>;
  AI?: Ai;
  ADMIN_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ENVIRONMENT: string;
  SITE_NAME: string;
  SITE_URL: string;
  AI_MODEL?: string;
  DAILY_NEURON_BUDGET?: string;
  AUTO_PUBLISH?: string;
  DISCOVERY_URL?: string;
  OPML_URL?: string;
  REQUIRE_ACCESS_JWT?: string;
  SEED_ON_START?: string;
};

export type Variables = {
  site: SiteState;
  admin: string | null;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type QueueMessage =
  | { kind: "job"; jobId: string }
  | { kind: "discover"; reason?: string };

export function bool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function dailyNeuronBudget(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "8000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 9_000) : 8_000;
}
