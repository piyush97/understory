import type { Block, Explanation, Inline } from "../domain/explanation";
import type { SourceBlock } from "../domain/source";
import { NEW_FIXTURES } from "./fixtures-2026-10-20";

const r = (text: string, cite?: string, extra: Partial<Inline> = {}): Inline => ({
  text,
  ...(cite ? { cite } : {}),
  ...extra,
});

const p = (...runs: Inline[]): Block => ({ type: "p", runs });
const list = (items: Inline[][], ordered = false): Block => ({
  type: "list",
  items,
  ...(ordered ? { ordered } : {}),
});
const note = (title: string, ...runs: Inline[]): Block => ({
  type: "note",
  tone: "note",
  title,
  runs,
});

const block = (
  id: string,
  kind: SourceBlock["kind"],
  text: string,
  sourceUrl: string,
  headingPath: string[] = [],
): SourceBlock => ({ id, kind, text, sourceUrl, headingPath });

export type FixtureArticle = {
  source: {
    id: string;
    name: string;
    siteUrl: string;
    host: string;
    feedUrl?: string;
  };
  topic: {
    id: string;
    label: string;
    description: string;
    sortOrder: number;
  };
  article: {
    id: string;
    canonicalUrl: string;
    originalTitle: string;
    publishedAt: string;
    discoveredAt: string;
    author: string | null;
    summary: string | null;
    slug: string;
    status: "published" | "discovered" | "review";
  };
  snapshot?: {
    id: string;
    sourceHash: string;
    blocks: SourceBlock[];
    wordCount: number;
    fetchedAt: string;
    finalUrl: string;
    httpStatus: number;
  };
  explanation?: Explanation;
};

const cloudflareUrl =
  "https://blog.cloudflare.com/obsessive-inference-optimization/";
const tailscaleUrl = "https://tailscale.com/blog/magicroute-beta";
const githubUrl =
  "https://github.blog/engineering/architecture-optimization/from-2500-requests-to-24-rebuilding-star-history-without-the-stargazers/";
const lemireUrl =
  "https://lemire.me/blog/2026/10/17/decoding-base64-in-python-at-10-gigabytes-per-second/";

const cloudflare: FixtureArticle = {
  source: {
    id: "cloudflare-blog",
    name: "Cloudflare",
    siteUrl: "https://blog.cloudflare.com/",
    host: "blog.cloudflare.com",
    feedUrl: "https://blog.cloudflare.com/rss/",
  },
  topic: {
    id: "ai-infrastructure",
    label: "AI infrastructure",
    description:
      "Serving, evaluating, and paying for models in production. The unglamorous half of AI engineering.",
    sortOrder: 10,
  },
  article: {
    id: "art_cloudflare_inference_optimization",
    canonicalUrl: cloudflareUrl,
    originalTitle:
      "Cutting our inference bill by 68% by being obsessive about optimization",
    publishedAt: "2026-10-19T15:20:00.000Z",
    discoveredAt: "2026-10-19T18:00:00.000Z",
    author: "Ryan Skidmore",
    summary:
      "Cloudflare's AI code reviewer got twice as expensive in five months. The company traced the bill to prompt-cache misses and redundant calls, then cut the average review from $2.43 to $0.77.",
    slug: "cutting-inference-bill-prompt-cache-optimization",
    status: "published",
  },
  snapshot: {
    id: "snap_cloudflare_inference",
    sourceHash: "fixture-cloudflare-inference-v1",
    fetchedAt: "2026-10-19T18:05:00.000Z",
    finalUrl: cloudflareUrl,
    httpStatus: 200,
    wordCount: 2410,
    blocks: [
      block(
        "b1",
        "quote",
        "An average review now costs $0.77 instead of $2.43, and the median one finishes in 1m 32s instead of 4m 9s.",
        cloudflareUrl,
        ["Where this leaves us"],
      ),
      block(
        "b2",
        "quote",
        "cache writes cost 43%, and cache reads cost 34%",
        cloudflareUrl,
        ["So, where were the tokens going?"],
      ),
      block(
        "b3",
        "quote",
        "The data showed that the first request of a session found a cached prefix only 14% to 26% of the time.",
        cloudflareUrl,
        ["Sharing a cached prefix between every repository"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "The AI reviewer got expensive. The fix was in the first request.",
    dek: "Cloudflare traced a doubling review bill to prompt-cache misses and redundant agent calls, then cut the average review from $2.43 to $0.77 without losing real findings.",
    oneSentence:
      "Most of the savings came from making every review start with the same cached prefix and from giving models less busywork.",
    tldr: [
      "Average AI review cost rose from $1.19 in April to $2.46 by August, mostly because sessions reused more tokens and switched to pricier models.",
      "Cache writes and reads made up 77% of spend, yet only 14% to 26% of sessions hit a shared cached prefix even though the first 11k to 21k tokens were identical.",
      "Splitting the system prompt at a shared marker and moving reference material into the prompt cut cost to $2.02. Tool and model changes took it to $0.77.",
      "Code quality at high effort still found about as many acted-on problems. It produced far fewer inflated severities.",
    ],
    sections: [
      {
        id: "where-the-money-went",
        title: "Where the money went",
        blocks: [
          p(
            r(
              "The review system had not changed shape. A coordinator still sent merge requests to a set of specialist reviewers, and risk tiers still decided how much work each one did. The bill nevertheless doubled from $1.19 in April to $2.46 by late August.",
              "s1",
            ),
          ),
          p(
            r(
              "Cloudflare's first useful measurement was not a total. It was a split. Output tokens were about 23% of spend. Cache writes were 43%, and cache reads were 34%.",
              "s1",
            ),
            r(" Most of the money went to context the model had already seen or would see again."),
          ),
          p(
            r("That pattern comes from how prompt caching works. A provider stores a prefix of the conversation, meaning the messages at the start. A later request can reuse that prefix up to the point where its content diverges. Writing a cache entry costs 1.25 times the normal input price. Reading one costs a tenth. An entry expires after five minutes unless something reads it again.", "s2"),
          ),
          p(
            r("A single code-quality review made 16.6 model calls on average. Across those calls it wrote 72k tokens into the cache and read back 1.08 million, because every call sent the whole conversation as context. Cost grows with the number of calls and with the size of the context, and both had crept up over five months."),
          ),
        ],
      },
      {
        id: "share-the-first-request",
        title: "Make the first request shareable",
        blocks: [
          p(
            r(
              "The reviewer had an obvious caching opportunity. Every session began with the same tool definitions and the same agent prompt, between 11k and 21k tokens that did not vary by repository. Those sessions should have been cache hits. Only 14% to 26% of first requests found a cached prefix.",
              "s1",
            ),
          ),
          p(
            r("The cause was the order of the prompt. Version one of OpenCode built one block containing the agent prompt, then an environment section with the working directory and the date. The only cache breakpoint sat at the end of that block. The shared part was never stored on its own, so a review in one repository could not reuse what a review in another repository had written."),
          ),
          p(
            r("The fix was small in code and large in effect: put a marker at the end of the agent prompt, then split the block there with a plugin hook. The first half now ended on bytes every job shared and got its own breakpoint. Anything repository-specific had to move behind that marker. The list of available skills was disabled, and tool descriptions could no longer change between jobs."),
          ),
          p(
            r(
              "On the same day, Cloudflare moved its internal standards reviewer's reference index into the prompt. Before that, every session spent its first three turns reading those files through tool calls. Calls per run fell from 15.9 to 9.6, and cost per run fell from $1.12 to $0.72.",
              "s1",
            ),
          ),
          p(
            r("Together, those changes took the average review from $2.47 to $2.02. The drop was visible as soon as the release went out."),
          ),
        ],
      },
      {
        id: "remove-the-busywork",
        title: "Remove calls that did no work",
        blocks: [
          p(
            r(
              "The next batch of changes did not look impressive one at a time. Together they removed about $0.20 from every review.",
              "s1",
            ),
          ),
          list([
            [
              r(
                "Sub-reviewers could see the tool that posts the final review comment. In 57% to 76% of sessions they tried to call it, were rejected by the server, then spent another call recovering. Removing the tool saved a call and about 2.9k tokens of tool definitions per request.",
                "s1",
              ),
            ],
            [
              r("In 64% of the code-quality reviewer's turns, the model made exactly one tool call, usually to read one file. Reading the shared context and patches in parallel removed the round trips."),
            ],
            [
              r("About two-thirds of jobs are second or later reviews of the same merge request. On full-tier re-reviews, AGENTS.md reviews were skipped 56% of the time, performance reviews 23%, and documentation reviews 13%."),
            ],
            [
              r("OpenCode used to pass the result back to the model for one more turn, which reread the conversation to write a summary nobody saw. Stopping after the review posted saved about $0.07 per job."),
            ],
            [
              r("A canceled GitLab job did not always stop. In a sample of 446 canceled jobs, 358 kept running to completion. The reviewer now checks its own status every 15 seconds."),
            ],
          ]),
          p(
            r("The most involved change shared one prefix across the code quality, security, and performance reviewers. All three send the same first request: the same tools, a shared rules file, then the merge request with every patch. Their own instructions follow. One writes the cache and the other two read it."),
          ),
          p(
            r("A cache entry cannot be read until the response that wrote it starts streaming, and the three reviewers start together. The second and third wait for the first response to begin, for up to 20 seconds. That delay costs a little latency and saves about nine cents per reviewer."),
          ),
        ],
      },
      {
        id: "models-and-effort",
        title: "Change the model mix, not just the code",
        blocks: [
          p(
            r(
              "Code changes accounted for $0.65 of the $1.67 reduction. Model and effort changes accounted for $1.06. The comparison is not a controlled experiment. It divides the period at each release and configuration change, then compares weekday hours before and after.",
              "s1",
            ),
          ),
          p(
            r("The coordinator had been running three model and effort combinations since August. On the same model, full-tier jobs at medium effort finished 20% sooner, so the other two combinations were dropped. A later randomized split found no measurable change in review outcomes or critical findings between Opus 5.5 at medium and Opus 5 at its prior setting. Opus 5.5 at high effort cost more than medium without a meaningful increase in findings."),
          ),
          p(
            r(
              "On October 3, every Sonnet reviewer was split 50/50 between Sonnet 5 and Sonnet 5.5. After two and a half days, Sonnet 5.5 was 62% cheaper per run for code quality, 58% for performance, and 47% for security. Both models cost the same per token, so the savings came from using fewer tokens.",
              "s1",
            ),
          ),
          p(
            r("On Sonnet 5.5 at medium effort, the code-quality reviewer makes 1.7 model calls per run instead of 6.2. More than half of its runs finish in a single call, without opening another file. At high effort it makes 3.4 calls. High effort costs 61% more per run and posts 58% more critical and warning findings. That works out to about two cents per review, and the quality evidence below made it worth paying."),
          ),
        ],
      },
      {
        id: "quality-check",
        title: "Check what the cheaper reviewer misses",
        blocks: [
          p(
            r(
              "A cheaper review is only a win if it still catches real problems. Cloudflare checked that from two directions.",
              "s1",
            ),
          ),
          p(
            r(
              "First, it looked at whether authors acted on a finding. For samples of critical and warning findings, it compared the reviewed commit with the author's next push. A finding counted as acted on if the lines it pointed at changed. Lines 30 to 40 away from each finding changed about 15% of the time in every period, which gives a baseline for coincidence.",
              "s1",
            ),
          ),
          p(
            r(
              "Before the changes, authors acted on 34% of the code-quality reviewer's serious findings. Afterward, they acted on 59%. The reviewer flagged fewer things, but the flags were more likely to lead to a change. Findings that led to a change per 1,000 reviews were about the same: 132 against 145 before, within the margin of error. Across all four reviewers, acted-on serious findings rose from 229 to 321 per 1,000 reviews.",
              "s1",
            ),
          ),
          p(
            r(
              "Second, two models from different providers judged a blinded sample of 657 findings from the three Sonnet reviewers. Each finding came with the diff it referred to, without the period it came from. Disagreements went to a third model. Important findings per review went from 0.28 to 0.30, with overlapping intervals. The clearest change was severity: judges rated 0.46 critical or warning findings per review as more severe than they deserved before, and 0.14 after. That is a 70% drop.",
              "s1",
            ),
          ),
          p(
            r("The result depended on the reviewer. Code quality at high effort mostly lost noise and inflated severity. Performance at medium effort lost real findings: judges found about 64% fewer important performance issues per review, roughly one fewer every 24 full-tier reviews. Security fell by about a quarter, though that was not statistically significant. Both are still at medium effort, and testing them at high is next."),
          ),
          p(
            r("Neither method is perfect. An author changing the flagged lines shows they did something, not that the finding was correct. The judges are models too, and each group held only 35 to 66 findings. The after window was one day long. The two methods agree with each other, and neither suggests code quality is finding fewer real problems."),
          ),
        ],
      },
      {
        id: "what-transfers",
        title: "What transfers to another agent",
        blocks: [
          p(
            r(
              "The largest single saving came from checking what actually reached the provider on each session's first request. The shared prefix was supposed to hit the cache almost every time. It did not. Measuring the hit rate turned a vague cost problem into a prompt-ordering bug.",
              "s1",
            ),
          ),
          p(
            r("The second lesson is to evaluate quality separately from cost. A lower bill can hide a shallower reviewer. Cloudflare used acted-on findings and blinded model judgments, then kept high effort where it paid and flagged the reviewer that lost real findings. The final recommendation is narrow: if you run agents at volume, check the first-request cache hit rate, and check whether the reviewer still finds problems at the effort level you are paying for."),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "One shared prefix, three reviewers",
      description:
        "A simplified view of the review path after Cloudflare's changes. The coordinator sends a shared prefix once, then specialists reuse it while reading the same merge request.",
      conceptual: true,
      nodes: [
        { id: "coordinator", label: "Coordinator", detail: "picks a risk tier" },
        {
          id: "prefix",
          label: "Shared prefix",
          detail: "tools, rules, agent prompt",
          cite: "s1",
        },
        { id: "patch", label: "Merge request", detail: "diff and repository context" },
        { id: "quality", label: "Code quality", cite: "s1" },
        { id: "security", label: "Security", cite: "s1" },
        { id: "performance", label: "Performance", cite: "s1" },
        { id: "verdict", label: "Review verdict", detail: "findings and summary" },
      ],
      edges: [
        { from: "coordinator", to: "prefix", label: "first request" },
        { from: "coordinator", to: "patch", label: "merge request" },
        { from: "prefix", to: "quality", label: "cache" },
        { from: "prefix", to: "security", label: "cache" },
        { from: "prefix", to: "performance", label: "cache" },
        { from: "patch", to: "quality" },
        { from: "patch", to: "security" },
        { from: "patch", to: "performance" },
        { from: "quality", to: "verdict" },
        { from: "security", to: "verdict" },
        { from: "performance", to: "verdict" },
      ],
      caption:
        "The real path has more branches and retries. The money-saving part is the shared prefix at the front.",
    },
    eli5: {
      body: [
        p(
          r("Imagine three reviewers who each start a job by rereading the same 20-page handbook. Every reviewer photocopies the handbook, then reads it again. The copies are most of the bill."),
        ),
        p(
          r("Cloudflare put one copy in a tray at the front of the room. Each reviewer picks it up, reads the few pages that are specific to this merge request, and gets to work. One reviewer has to put the copy there first, so the other two wait a moment."),
        ),
      ],
      limit:
        "The tray only works if the first pages are identical. A date or a working directory tucked into the wrong place makes every copy slightly different, and the shared copy never gets used.",
    },
    tradeoffs: [
      {
        title: "Cheaper calls, less coverage",
        body: "Skipping reviewers and lowering effort cut the bill, but performance at medium effort lost about two-thirds of important findings. Code quality at high effort held up. The right level depends on what the reviewer is allowed to miss.",
      },
      {
        title: "Shared prefix, cold-start wait",
        body: "The second and third reviewers wait up to 20 seconds for the cache writer's response to start. That is a deliberate trade: a little latency for about nine cents per reviewer.",
      },
      {
        title: "Cache reuse, prompt discipline",
        body: "The shared prefix only stays shared if repository-specific text and mutable tool descriptions stay out of it. That is an ongoing architectural constraint, not a one-time patch.",
      },
    ],
    whenUseful: [
      "Your agent bill grows faster than usage and most tokens are cache reads or writes.",
      "Sessions share a stable system prompt, tool set, and rules file.",
      "You can measure quality with acted-on findings or blinded review, not just approval rates.",
    ],
    caveats: [
      "The before-and-after cost comparison is not a controlled experiment; releases and configuration changes are confounded.",
      "The quality recheck used small samples, a one-day after window, and model judges.",
    ],
    sources: [
      {
        id: "s1",
        label:
          "Cloudflare: Cutting our inference bill by 68% by being obsessive about optimization",
        url: cloudflareUrl,
        note: "Published 19 October 2026. Cost, cache, tooling, and quality figures come from this post.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "Anthropic: Prompt caching",
        url: "https://docs.claude.com/en/docs/build-with-claude/prompt-caching",
        note: "Background on prefix caching, cache writes, reads, and the five-minute default lifetime.",
      },
      {
        id: "s3",
        label: "Cloudflare: Building an AI code reviewer",
        url: "https://blog.cloudflare.com/ai-code-review/",
        note: "The original architecture described in April, before the cost work.",
      },
    ],
    readingMinutes: 7,
    topic: "ai-infrastructure",
  },
};

const tailscale: FixtureArticle = {
  source: {
    id: "tailscale",
    name: "Tailscale",
    siteUrl: "https://tailscale.com/blog",
    host: "tailscale.com",
    feedUrl: "https://tailscale.com/blog/index.xml",
  },
  topic: {
    id: "networking",
    label: "Networking",
    description:
      "Routing, connectivity, and the protocols that hold distributed systems together.",
    sortOrder: 20,
  },
  article: {
    id: "art_tailscale_magicroute",
    canonicalUrl: tailscaleUrl,
    originalTitle: "MagicRoute: Routing without physical routers",
    publishedAt: "2026-10-19T14:00:00.000Z",
    discoveredAt: "2026-10-19T18:00:00.000Z",
    author: null,
    summary:
      "Tailscale's regional routing could flap between connectors with nearly identical latency. MagicRoute scores connectors from each client's view and keeps the preferred one while it is healthy.",
    slug: "magicroute-routing-without-physical-routers",
    status: "published",
  },
  snapshot: {
    id: "snap_tailscale_magicroute",
    sourceHash: "fixture-tailscale-magicroute-v1",
    fetchedAt: "2026-10-19T18:06:00.000Z",
    finalUrl: tailscaleUrl,
    httpStatus: 200,
    wordCount: 940,
    blocks: [
      block(
        "b1",
        "quote",
        "MagicRoute scores and ranks each connector in a tailnet from the client's point of view.",
        tailscaleUrl,
        ["How MagicRoute works"],
      ),
      block(
        "b2",
        "quote",
        "Clients keep on using their preferred connector, so long as it's healthy, which avoids breaking connections unnecessarily.",
        tailscaleUrl,
        ["How MagicRoute works"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "Routing that stays put",
    dek: "Tailscale replaced regional routing with per-client scoring, so connectors stop flapping between nearly identical regions and SSH sessions survive.",
    oneSentence:
      "MagicRoute ranks connectors from each client's point of view, picks the nearest healthy one, and keeps using it until it fails.",
    tldr: [
      "Regional routing matched clients to connectors by DERP home. Connectors with similar latency could flap between regions, breaking active connections for every client on them.",
      "MagicRoute scores each connector per client, mostly from coarse location, and keeps the preferred connector while it is healthy.",
      "Ties are spread across equally good connectors. When the preferred one fails, clients work down the ranked list.",
      "It works with custom DERP servers and ships as a tailnet-wide beta option for Premium and Enterprise customers.",
    ],
    sections: [
      {
        id: "regional-home",
        title: "The problem with a regional home",
        blocks: [
          p(
            r(
              "A second subnet router usually exists for one of three reasons: redundancy, capacity, or proximity. Once there are two, the client needs a rule for choosing. Tailscale's previous rule grouped connectors by their home DERP region and matched each client to a connector in the same or nearest region.",
              "s1",
            ),
          ),
          p(
            r(
              "That rule assumed regions produce a clear winner. On a fast backbone or at a major exchange point, a connector's latency to several DERP regions can be within a couple of milliseconds. Small amounts of jitter can make it pick one region as home, jump to another, then bounce back.",
              "s1",
            ),
          ),
          p(
            r("When a connector flaps, every client using it loses existing connections. SSH sessions drop, large file transfers stop partway. Clients that shared its DERP home may switch with it, so one unstable measurement can cascade through a tailnet."),
          ),
          p(
            r("Bad internet weather caused the same failure in less exotic places. A temporary slowdown could move a connector's home to another country. Customers running custom DERP servers were excluded from regional routing entirely because their regions did not map onto Tailscale's public ones."),
          ),
        ],
      },
      {
        id: "score-per-client",
        title: "Score from the client's side",
        blocks: [
          p(
            r(
              "MagicRoute ranks every connector separately for each client. The client picks its top choice for each subnet route and app. If two connectors tie for first, clients are spread across them instead of all choosing the same one.",
              "s1",
            ),
          ),
          p(
            r(
              "The signal today is coarse location. Tailscale estimates where the client is and keeps only enough precision to find the nearest connector. Approximate distance has a useful property: it does not change when the network has a bad minute, unlike a live latency measurement.",
              "s1",
            ),
          ),
          p(
            r("The client keeps its preferred connector while that connector is healthy. This is the stability half of the design. A marginally faster path is not worth breaking an active session. When the preferred connector goes offline, the client walks down the ranked list until it finds a healthy one."),
          ),
          p(
            r("Because the ranking no longer depends on DERP regions, it also works with custom DERP servers. The ranking is a preference order, not a measurement of whether packets can actually reach the connector. Tailscale says reachability checks, where clients ask whether they can get packets through, are still being worked on."),
          ),
        ],
      },
      {
        id: "console-change",
        title: "What changed in the console",
        blocks: [
          p(
            r("Route selection now has four modes. Active-passive failover keeps one primary connector and stands others by. Regional routing uses the old DERP-region rule. Regional routing with in-region failover adds a standby per region and requires support to enable. MagicRoute lets each client choose the nearest healthy machine and keeps sessions steady."),
          ),
          p(
            r(
              "The setting applies to the whole tailnet. There are no per-connector opt-outs. Tailscale's reasoning is that routing rules interact, and letting administrators tune individual nodes would produce behavior that is hard to predict.",
              "s1",
            ),
          ),
          p(
            r("MagicRoute is in beta for Premium and Enterprise customers. All client versions support it for subnet routers, app connectors, and Tailscale Service hosts. Clients since version 1.86.0 support it when suggesting exit nodes."),
          ),
        ],
      },
      {
        id: "what-remains",
        title: "What it does not solve yet",
        blocks: [
          p(
            r("The current score is a guess about proximity, not a probe of the path. Two connectors can be equally close on a map and very different in practice. Tailscale is considering reachability checks and more signals for the score. Until those ship, MagicRoute is a stability improvement with a simple model of distance, not a full traffic-aware router."),
          ),
          p(
            r("The beta also does not offer per-connector control. A team with an unusual topology, such as a connector that should only serve one office, gets the tailnet-wide policy. That is a deliberate simplification, and it is the kind of simplification that will need revisiting if enough networks hit its edges."),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "From a location signal to a stable choice",
      description:
        "Each client ranks connectors for itself. It holds the best healthy choice until that connector fails, then moves down the list.",
      conceptual: true,
      nodes: [
        { id: "clients", label: "Clients", detail: "one ranking per client" },
        { id: "location", label: "Coarse location", detail: "approximate distance" },
        { id: "score", label: "Connector score", cite: "s1" },
        { id: "rank", label: "Ranked list", cite: "s1" },
        { id: "hold", label: "Hold preferred", detail: "while healthy" },
        { id: "failover", label: "Next healthy", detail: "on failure" },
      ],
      edges: [
        { from: "clients", to: "score", label: "ask" },
        { from: "location", to: "score", label: "signal" },
        { from: "score", to: "rank" },
        { from: "rank", to: "hold", label: "top choice" },
        { from: "rank", to: "failover", label: "if unhealthy" },
      ],
      caption:
        "A tie at the top is spread across clients. The diagram omits the tailnet-wide policy switch.",
    },
    eli5: {
      body: [
        p(
          r("You leave a train station with two exits that are about the same distance from your office. You pick one and keep using it every day. If it is closed, you walk to the other. You do not switch exits because the queue at the first one moved two feet."),
        ),
        p(
          r("Tailscale's old system was more like assigning each exit a neighborhood and sending everyone in that neighborhood to it, even when the exits were side by side. A tiny delay could make the assignment flip, and everyone would turn around at once."),
        ),
      ],
      limit:
        "Location is a guess about distance, not a test of whether the path works. A connector can be close on the map and still be the wrong choice.",
    },
    tradeoffs: [
      {
        title: "Stability over the shortest path",
        body: "MagicRoute keeps a healthy connector instead of chasing a slightly faster measurement. That protects sessions, but it may not always use the lowest-latency path.",
      },
      {
        title: "One policy for the tailnet",
        body: "No per-connector opt-outs keeps behavior predictable. It also removes an escape hatch for unusual topologies that need finer control.",
      },
      {
        title: "Simple signal, clear limits",
        body: "Coarse location does not flap with network weather, but it cannot tell whether packets actually reach a connector. Reachability checks are future work.",
      },
    ],
    whenUseful: [
      "A tailnet has multiple connectors advertising the same routes.",
      "Connectors sit near backbone or exchange points where regional latency is nearly tied.",
      "Dropped sessions cost more than a marginally longer path.",
    ],
    caveats: [
      "MagicRoute is in beta and limited to Premium and Enterprise plans.",
      "The current score uses location, not measured reachability or live path quality.",
    ],
    sources: [
      {
        id: "s1",
        label: "Tailscale: MagicRoute, routing without physical routers",
        url: tailscaleUrl,
        note: "Published 19 October 2026. Quotes and product details come from this post.",
        evidenceIds: ["b1", "b2"],
      },
      {
        id: "s2",
        label: "Tailscale docs: Route selection",
        url: "https://tailscale.com/kb/1568/route-selection",
        note: "Reference for the four route-selection modes and plan availability.",
      },
      {
        id: "s3",
        label: "Tailscale docs: Subnet routers",
        url: "https://tailscale.com/kb/1019/subnets",
        note: "Background on advertising routes and overlapping subnet routers.",
      },
    ],
    readingMinutes: 4,
    topic: "networking",
  },
};

const github: FixtureArticle = {
  source: {
    id: "github-blog",
    name: "GitHub",
    siteUrl: "https://github.blog/engineering/",
    host: "github.blog",
    feedUrl: "https://github.blog/feed/",
  },
  topic: {
    id: "databases",
    label: "Databases & query engines",
    description:
      "How storage systems answer questions, and why the shape of a query matters more than the size of its result.",
    sortOrder: 30,
  },
  article: {
    id: "art_github_star_history",
    canonicalUrl: githubUrl,
    originalTitle:
      "From 2,500 requests to 24: Rebuilding star history without the stargazers",
    publishedAt: "2026-10-14T16:00:00.000Z",
    discoveredAt: "2026-10-15T06:00:00.000Z",
    author: "GitHub Engineering",
    summary:
      "GitHub's star-history endpoint used to page through people, and every page counted every star. The replacement pages through weeks and filters by date before it counts.",
    slug: "rebuilding-star-history-without-stargazers",
    status: "published",
  },
  snapshot: {
    id: "snap_github_star_history",
    sourceHash: "fixture-github-star-history-v1",
    fetchedAt: "2026-10-15T06:05:00.000Z",
    finalUrl: githubUrl,
    httpStatus: 200,
    wordCount: 1710,
    blocks: [
      block(
        "b1",
        "quote",
        "For react/react, that's about 24 requests instead of about 2,511, and the database examines each star about once (roughly 251,000 rows) across the full history.",
        githubUrl,
        ["Filtering by time before grouping"],
      ),
      block(
        "b2",
        "quote",
        "The time-range design limits each request to a defined period, but it does not limit the number of stars within that range.",
        githubUrl,
        ["Filtering by time before grouping"],
      ),
      block(
        "b3",
        "quote",
        "The design we shipped paginates star history by calendar week.",
        githubUrl,
        ["Filtering by time before grouping"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "Fewer rows, same curve",
    dek: "GitHub's star-history API went from 2,511 requests for react/react to 24 by filtering on an indexed date range before counting.",
    oneSentence:
      "The old endpoint paginated people. The new one paginates weeks and touches only the stars in those weeks.",
    tldr: [
      "Reconstructing star history from the stargazer list took about 2,511 requests for a 251,000-star repository, and every request counted every star to work out pagination.",
      "Removing identities fixed scraping but not query cost. Aggregating and then paginating still scanned the whole star set.",
      "The new endpoint maps page and page size to an indexed created_at range, filters first, then groups daily counts.",
      "Dense weeks, calendar boundaries, and removed stars still limit what the curve can show.",
    ],
    sections: [
      {
        id: "identity-tax",
        title: "The identity tax",
        blocks: [
          p(
            r("Maintainers use star history to answer a practical question: did a launch, release, or event change a project's trajectory? For years, the only way to reconstruct that curve from GitHub's API was to page through stargazer records, keep the timestamps, and throw away the names.", "s1"),
          ),
          p(
            r("The old endpoint returned up to 100 people per page. A repository with 251,000 stars needed about 2,511 requests to build the full curve. Tools often hit rate limits or sampled pages instead. The same data was also useful to scrapers building spam and phishing lists."),
          ),
          p(
            r(
              "Serving a page had a second problem. The pagination implementation counted all of the repository's current stars on every request to work out how many pages existed, even though the caller received one page. In the week before access was restricted, nearly 37,000 count queries ran slowly enough to be logged, averaging nearly three seconds each. Database safeguards killed more than 1,000.",
              "s1",
            ),
          ),
          p(
            r(
              "Restricting stargazer and watcher lists to administrators and collaborators cut requests by about 60% and the time spent in the count query by about 80%. It also broke the tools that had depended on the list. That is when GitHub talked to maintainers and found out they cared about the curve, not the names.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "less-data-not-less-work",
        title: "Returning less data did not make the query cheaper",
        blocks: [
          p(
            r("The obvious next step was to return counts instead of people. A query could group stars into daily or weekly buckets, sort the buckets, and paginate the much smaller result. The response would be tiny. The work would not be."),
          ),
          p(
            r(
              "Pagination happened after aggregation. The database first found every star for the repository, grouped them, and sorted the buckets. Only then did LIMIT and OFFSET choose a page. For react/react, reading the full history that way would have meant examining roughly 6 million rows across 24 requests, because each request reprocessed all of the stars.",
              "s1",
            ),
          ),
          p(
            r("A smaller JSON response and a cheaper database query are different goals. LIMIT changes how much the caller receives. It does not change how much work the database did before the limit was applied."),
          ),
        ],
      },
      {
        id: "filter-before-group",
        title: "Filter by time, then group",
        blocks: [
          p(
            r(
              "The shipped design paginates star history by calendar week. Each request translates page and page size into an indexed created_at range, filters the stars to those weeks, and groups the matching records into daily counts. A response covers up to 30 weeks, and increasing the page moves backward through history.",
              "s1",
            ),
          ),
          p(
            r(
              "For react/react, the full history now takes about 24 requests instead of about 2,511. Across those requests, the database examines each star roughly once, about 251,000 rows, instead of rescanning the whole set for every page. The response shape also matches the weekly commit activity endpoint, which gives clients one less shape to learn.",
              "s1",
            ),
          ),
          p(
            r("The change is a reordering of work, not a new storage engine. Put the selective filter before the expensive grouping and sorting. The index on created_at does the rest."),
          ),
        ],
      },
      {
        id: "limits",
        title: "The limits that remain",
        blocks: [
          p(
            r(
              "A date range bounds a request in time, not in row count. A week with an unusual number of stars can still be expensive. Calendar boundaries can split an event across pages. Removed stars disappear from the current set, so the curve is a history of current stargazers, not a complete event log.",
              "s1",
            ),
          ),
          p(
            r("GitHub also found the same count-on-demand pattern on the repository stargazers page and switched it to a cached star count. Slow queries from that page, which had numbered in the hundreds each week, dropped to zero."),
          ),
          p(
            r("The endpoint is safer and more predictable than the list it replaced. It is not a full time-series database, and the post is clear about that. Dense weeks remain a scaling limitation, and the API contract says so."),
          ),
        ],
      },
      {
        id: "what-transfers",
        title: "What transfers",
        blocks: [
          p(
            r("The first lesson is that a smaller response does not always mean a cheaper query. Look at the order of operations, not only the size of the payload."),
          ),
          p(
            r("The second is to start with the job rather than the existing endpoint. Maintainers wanted trends. The list of identities was an implementation detail that had become part of the contract."),
          ),
          p(
            r("The third is to keep the remaining tradeoffs in the documentation. Calendar boundaries, removed stars, and dense weeks are part of what the API can and cannot promise."),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "Old path, new path",
      description:
        "Both paths return a star-history curve. The difference is whether the database filters before or after it groups and sorts.",
      conceptual: true,
      nodes: [
        { id: "request", label: "History request" },
        { id: "old-scan", label: "Scan every star", detail: "old path", cite: "s1" },
        { id: "old-page", label: "Page of 100", detail: "repeat 2,511 times" },
        { id: "new-range", label: "Indexed week range", detail: "new path", cite: "s1" },
        { id: "new-count", label: "Daily counts", detail: "filter, then group" },
        { id: "response", label: "Curve response" },
      ],
      edges: [
        { from: "request", to: "old-scan", label: "old" },
        { from: "old-scan", to: "old-page", label: "count all" },
        { from: "old-page", to: "response", label: "client joins" },
        { from: "request", to: "new-range", label: "new" },
        { from: "new-range", to: "new-count" },
        { from: "new-count", to: "response", label: "one pass" },
      ],
      caption:
        "The old path also counted every star to compute pagination. The new path never asks for a page before narrowing the rows.",
    },
    eli5: {
      body: [
        p(
          r("You want the number of people who entered a stadium each day. The old way was to ask for every ticket stub, 100 at a time, then sort them yourself. For a big stadium, that meant thousands of requests."),
        ),
        p(
          r("The new way asks the ticket office for daily counts, but only after it has pulled the stubs from the days you asked about. The office still reads the stubs in those days. It does not read every stub ever sold."),
        ),
      ],
      limit:
        "A day with an enormous crowd is still a lot of stubs. Filtering by date bounds the time window, not the number of people inside it.",
    },
    tradeoffs: [
      {
        title: "Aggregates over identities",
        body: "The new endpoint returns counts without usernames. That is safer and cheaper, but tools that genuinely needed per-user data lost it.",
      },
      {
        title: "Week buckets over arbitrary ranges",
        body: "Weeks align with an index and with the commit activity API. They also put calendar boundaries into the result and leave dense weeks as a scaling edge.",
      },
      {
        title: "Breaking change, then collaboration",
        body: "Restricting the old endpoint disrupted Star History. Talking to maintainers produced a purpose-built replacement, but only after the break.",
      },
    ],
    whenUseful: [
      "A database query aggregates or sorts far more rows than it returns.",
      "Pagination is applied after an expensive grouping step.",
      "An API response can be redesigned around the question users actually ask.",
    ],
    caveats: [
      "The new history is based on current stargazers, so removed stars are not represented.",
      "Dense weeks can still produce slow queries; the date range does not bound row count.",
    ],
    sources: [
      {
        id: "s1",
        label:
          "GitHub: From 2,500 requests to 24, rebuilding star history without the stargazers",
        url: githubUrl,
        note: "Published 14 October 2026. Request counts, query plans, and limits come from this post.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "GitHub REST API: Stargazers",
        url: "https://docs.github.com/en/rest/activity/starring",
        note: "The endpoint discussed in the post and its access rules.",
      },
      {
        id: "s3",
        label: "GitHub REST API: Commit activity",
        url: "https://docs.github.com/en/rest/metrics/statistics",
        note: "The weekly activity response shape that the new star-history endpoint follows.",
      },
    ],
    readingMinutes: 5,
    topic: "databases",
  },
};

const lemire: FixtureArticle = {
  source: {
    id: "lemire",
    name: "Daniel Lemire",
    siteUrl: "https://lemire.me/blog/",
    host: "lemire.me",
    feedUrl: "https://lemire.me/blog/feed/",
  },
  topic: {
    id: "performance",
    label: "Performance",
    description:
      "Measuring what code actually does, down to the instruction and the memory copy.",
    sortOrder: 40,
  },
  article: {
    id: "art_lemire_fastpybase64",
    canonicalUrl: lemireUrl,
    originalTitle: "Decoding base64 in Python at 10 gigabytes per second",
    publishedAt: "2026-10-17T13:00:00.000Z",
    discoveredAt: "2026-10-18T06:00:00.000Z",
    author: "Daniel Lemire",
    summary:
      "A new Python binding for simdutf decodes base64 four times faster than pybase64 and 27 times faster than the standard library.",
    slug: "decoding-base64-python-10-gigabytes-per-second",
    status: "published",
  },
  snapshot: {
    id: "snap_lemire_fastpybase64",
    sourceHash: "fixture-lemire-fastpybase64-v1",
    fetchedAt: "2026-10-18T06:05:00.000Z",
    finalUrl: lemireUrl,
    httpStatus: 200,
    wordCount: 420,
    blocks: [
      block(
        "b1",
        "quote",
        "The fastpybase64 module is four times faster than pybase64 and 27 times faster than the standard library.",
        lemireUrl,
      ),
      block(
        "b2",
        "quote",
        "It is meant as a drop-in replacement for the standard base64 module.",
        lemireUrl,
      ),
      block(
        "b3",
        "quote",
        "I use an Intel Xeon Gold 6548N (Emerald Rapids) pinned to one core, with Python 3.14.6.",
        lemireUrl,
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "Base64 at memory-copy speed",
    dek: "A new Python binding for simdutf decodes base64 four times faster than pybase64 and 27 times faster than the standard library.",
    oneSentence:
      "The speed comes from SIMD decoding and a forgiving parser, exposed to Python through a drop-in module.",
    tldr: [
      "Python's base64 module processes input one character at a time. pybase64 is faster, but it is not the SIMD path simdutf uses.",
      "fastpybase64 binds simdutf, including the forgiving decoder that browsers use to skip spaces and line breaks.",
      "On one Emerald Rapids core, it decoded at about 10 GB/s, 4× pybase64 and 27× the standard library.",
      "It is a drop-in module on PyPI for Python 3.10 to 3.14, with wheels for Linux, macOS, and Windows.",
    ],
    sections: [
      {
        id: "three-bytes-four-chars",
        title: "Three bytes, four characters",
        blocks: [
          p(
            r(
              "Base64 turns binary data into text using 64 ASCII characters. Every three bytes become four characters. Email attachments use it, certificates store keys in it, web pages embed images with it, and JSON carries binary payloads inside it.",
              "s1",
            ),
          ),
          p(
            r("The encoding is simple enough to implement in a few lines. The interesting engineering is in decoding large volumes quickly, especially when the input arrives with line breaks and other whitespace."),
          ),
        ],
      },
      {
        id: "why-python-was-slow",
        title: "Why the standard library leaves speed on the table",
        blocks: [
          p(
            r(
              "Python's base64 module is written in C, but it processes the data one character at a time. pybase64 is a popular faster alternative. Neither uses the SIMD approach that Lemire and Wojciech Muła have worked on for years.",
              "s1",
            ),
          ),
          p(
            r("SIMD instructions decode many input characters per instruction. The tricky part is the forgiving variant: browsers skip spaces and line breaks rather than rejecting them. Lemire's simdutf library implements both the strict and forgiving paths, and mainstream browsers already use it."),
          ),
          p(
            r(
              "simdutf had no Python binding. fastpybase64 fills that gap and is meant to be a drop-in replacement for the standard module.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "benchmark",
        title: "The benchmark",
        blocks: [
          p(
            r(
              "The test machine was an Intel Xeon Gold 6548N (Emerald Rapids) pinned to one core, running Python 3.14.6. The benchmark used fastpybase64 0.1.0 and pybase64 1.5.1 from PyPI, decoded the base64 encoding of random bytes, and reported gigabytes of decoded data per second. The input included MIME line breaks every 76 characters, because real email base64 has them. It ran single-threaded.",
              "s1",
            ),
          ),
          p(
            r(
              "fastpybase64 reached about 10 GB/s. That was four times faster than pybase64 and 27 times faster than the standard library. The module ships wheels for Linux, macOS, and Windows, for Python 3.10 through 3.14, including the free-threaded build of 3.14.",
              "s1",
            ),
          ),
          p(
            r("Those numbers are a single machine and a single thread. The relative gap between one-character-at-a-time C and SIMD decoding is the transferable part. The absolute rate depends on the CPU, the input shape, and the Python build."),
          ),
        ],
      },
      {
        id: "when-to-use",
        title: "When to reach for it",
        blocks: [
          p(
            r("The module is most useful when a Python service decodes large base64 payloads: mail processing, certificate handling, data URLs, or binary fields in JSON. It is less compelling for a few kilobytes on a cold path, where adding a dependency costs more than the decode."),
          ),
          p(
            r("The benchmark is public, and the module is a drop-in import swap. That makes it easy to test on your own workload. Measure the input shape you actually have, including line breaks, before assuming the headline number transfers."),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "Where the SIMD path spends its time",
      description:
        "A simplified decode path. fastpybase64 hands the buffer to simdutf, which skips whitespace and decodes vector blocks in parallel before writing bytes.",
      conceptual: true,
      nodes: [
        { id: "python", label: "Python bytes", detail: "base64 text" },
        { id: "binding", label: "fastpybase64", detail: "C extension" },
        { id: "forgiving", label: "Forgiving scan", detail: "skip whitespace", cite: "s1" },
        { id: "simd", label: "SIMD decode", detail: "many characters at once", cite: "s1" },
        { id: "output", label: "Decoded bytes" },
      ],
      edges: [
        { from: "python", to: "binding" },
        { from: "binding", to: "forgiving" },
        { from: "forgiving", to: "simd" },
        { from: "simd", to: "output", label: "write" },
      ],
      caption:
        "Block widths depend on the CPU. The diagram shows the order of work, not the exact vector width.",
    },
    eli5: {
      body: [
        p(
          r("Base64 turns every three bytes into four letters. Most decoders read one letter at a time, like typing a barcode number into a till. SIMD reads a whole row of letters at once, like a scanner passing over the barcode."),
        ),
        p(
          r("The new Python module is a thin handle onto a decoder that already knows how to scan. It also knows how to ignore the line breaks that email adds, so you do not have to clean the text first."),
        ),
      ],
      limit:
        "The scanner still has to look at every line. The speedup comes from how many characters it handles per instruction, not from skipping the input.",
    },
    tradeoffs: [
      {
        title: "Speed against portability",
        body: "SIMD paths depend on the CPU and on wheels for each platform. The module ships several, but the fastest path is not available everywhere.",
      },
      {
        title: "Forgiving input against strictness",
        body: "Skipping whitespace matches browser behavior and real email. It can also accept input that a strict decoder would reject.",
      },
      {
        title: "Drop-in against dependency",
        body: "Swapping the import is easy. Adding a native extension to a service means tracking wheels, platforms, and Python versions.",
      },
    ],
    whenUseful: [
      "A Python service decodes large base64 payloads on a hot path.",
      "Input contains MIME line breaks or other whitespace.",
      "You can benchmark on the hardware and Python build you deploy.",
    ],
    caveats: [
      "The 10 GB/s figure is from one CPU, one core, and one input shape.",
      "The module is new; the standard library remains the conservative default for small or infrequent decodes.",
    ],
    sources: [
      {
        id: "s1",
        label:
          "Daniel Lemire: Decoding base64 in Python at 10 gigabytes per second",
        url: lemireUrl,
        note: "Published 17 October 2026. Benchmark details and performance figures come from this post.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "simdutf",
        url: "https://github.com/simdutf/simdutf",
        note: "The SIMD Unicode and base64 library that fastpybase64 binds.",
      },
      {
        id: "s3",
        label: "fastpybase64 on PyPI",
        url: "https://pypi.org/project/fastpybase64/",
        note: "Package versions, supported Python versions, and platform wheels.",
      },
    ],
    readingMinutes: 3,
    topic: "performance",
  },
};

const pending: FixtureArticle[] = [
  {
    source: {
      id: "meta-engineering",
      name: "Meta Engineering",
      siteUrl: "https://engineering.fb.com/",
      host: "engineering.fb.com",
      feedUrl: "https://engineering.fb.com/feed/",
    },
    topic: {
      id: "distributed-systems",
      label: "Distributed systems",
      description:
        "Coordination, failure, and the machinery behind large-scale infrastructure.",
      sortOrder: 60,
    },
    article: {
      id: "art_meta_prometheus",
      canonicalUrl:
        "https://engineering.fb.com/2026/10/19/data-center-engineering/inside-prometheus-meta-gigawatt-scale-supercluster/",
      originalTitle:
        "Inside Prometheus: Meta's Journey to a Gigawatt-Scale Supercluster",
      publishedAt: "2026-10-19T17:00:00.000Z",
      discoveredAt: "2026-10-19T18:00:00.000Z",
      author: null,
      summary:
        "Meta describes the power, cooling, and network design behind a supercluster measured in gigawatts.",
      slug: "inside-prometheus-meta-gigawatt-supercluster",
      status: "discovered",
    },
  },
  {
    source: {
      id: "aws-ml-blog",
      name: "AWS Machine Learning",
      siteUrl: "https://aws.amazon.com/blogs/machine-learning/",
      host: "aws.amazon.com",
      feedUrl: "https://aws.amazon.com/blogs/machine-learning/feed/",
    },
    topic: {
      id: "ai-infrastructure",
      label: "AI infrastructure",
      description:
        "Serving, evaluating, and paying for models in production. The unglamorous half of AI engineering.",
      sortOrder: 10,
    },
    article: {
      id: "art_aws_deepgram",
      canonicalUrl:
        "https://aws.amazon.com/blogs/machine-learning/how-deepgram-optimized-voice-ai-at-scale-with-aws-trainium/",
      originalTitle:
        "How Deepgram optimized voice AI at scale with AWS Trainium",
      publishedAt: "2026-10-19T16:00:00.000Z",
      discoveredAt: "2026-10-19T18:00:00.000Z",
      author: null,
      summary:
        "A case study of moving speech models onto custom silicon, with the tuning work that followed.",
      slug: "deepgram-voice-ai-aws-trainium",
      status: "discovered",
    },
  },
  {
    source: {
      id: "hugging-face",
      name: "Hugging Face",
      siteUrl: "https://huggingface.co/blog",
      host: "huggingface.co",
      feedUrl: "https://huggingface.co/blog/feed.xml",
    },
    topic: {
      id: "ai-infrastructure",
      label: "AI infrastructure",
      description:
        "Serving, evaluating, and paying for models in production. The unglamorous half of AI engineering.",
      sortOrder: 10,
    },
    article: {
      id: "art_hf_torchneuron",
      canonicalUrl: "https://huggingface.co/blog/hf-torchneuron",
      originalTitle:
        "TorchNeuron: running HF models on AWS Trainium is easier than ever",
      publishedAt: "2026-10-18T16:00:00.000Z",
      discoveredAt: "2026-10-19T18:00:00.000Z",
      author: null,
      summary:
        "A bridge for running Hugging Face models on Trainium with less custom glue.",
      slug: "torchneuron-hugging-face-models-aws-trainium",
      status: "discovered",
    },
  },
];

export const FIXTURE_ARTICLES: FixtureArticle[] = [
  cloudflare,
  tailscale,
  github,
  lemire,
  ...NEW_FIXTURES,
  ...pending,
];
