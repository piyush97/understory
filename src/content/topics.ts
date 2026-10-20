export type TopicSeed = {
  id: string;
  label: string;
  description: string;
  sortOrder: number;
};

/**
 * The fixed topic set. Generated explanations must pick one of these ids, so a
 * topic page never becomes a dead end with a single unexplained post.
 */
export const TOPIC_SEEDS: TopicSeed[] = [
  {
    id: "ai-infrastructure",
    label: "AI infrastructure",
    description:
      "Serving, evaluating, and paying for models in production. The unglamorous half of AI engineering.",
    sortOrder: 10,
  },
  {
    id: "networking",
    label: "Networking",
    description:
      "Protocols, routing, DNS, and the physical path between a request and a response.",
    sortOrder: 20,
  },
  {
    id: "databases",
    label: "Databases & query engines",
    description:
      "Storage engines, query systems, and the consistency trade-offs behind them.",
    sortOrder: 30,
  },
  {
    id: "performance",
    label: "Performance",
    description:
      "Profiling, latency, throughput, and the measurements that survive production.",
    sortOrder: 40,
  },
  {
    id: "security",
    label: "Security",
    description:
      "Threat models, sandboxing, and the cryptography that guards real systems.",
    sortOrder: 50,
  },
  {
    id: "distributed-systems",
    label: "Distributed systems",
    description:
      "Coordination, failure, and the machinery behind large-scale infrastructure.",
    sortOrder: 60,
  },
  {
    id: "developer-tools",
    label: "Developer tools",
    description:
      "Build systems, editors, test runners, and the workflows around them.",
    sortOrder: 70,
  },
  {
    id: "browsers",
    label: "Browsers",
    description:
      "Rendering, JavaScript engines, and the web platform underneath every page.",
    sortOrder: 80,
  },
  {
    id: "hardware",
    label: "Hardware",
    description:
      "Chips, memory, interconnects, and the data centers that hold them.",
    sortOrder: 90,
  },
  {
    id: "observability",
    label: "Observability",
    description:
      "Metrics, tracing, logging, and what actually helps during an incident.",
    sortOrder: 100,
  },
  {
    id: "programming-languages",
    label: "Programming languages",
    description:
      "Type systems, compilers, runtimes, and language design decisions.",
    sortOrder: 110,
  },
  {
    id: "cloud",
    label: "Cloud",
    description:
      "Compute, storage, deployment, and platform engineering at provider scale.",
    sortOrder: 120,
  },
  {
    id: "data-engineering",
    label: "Data engineering",
    description:
      "Pipelines, batch and stream processing, and the systems that move data.",
    sortOrder: 130,
  },
  {
    id: "open-source",
    label: "Open source",
    description:
      "Projects, governance, maintainership, and the work that keeps software shared.",
    sortOrder: 140,
  },
];

export const TOPIC_IDS = TOPIC_SEEDS.map((topic) => topic.id);

export function topicLabel(id: string): string {
  return TOPIC_SEEDS.find((topic) => topic.id === id)?.label ?? "Engineering";
}
