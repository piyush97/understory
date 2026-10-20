import type { Block, Explanation, Inline } from "../domain/explanation";
import type { SourceBlock } from "../domain/source";
import type { FixtureArticle } from "./fixtures";

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

const databases = {
  id: "databases",
  label: "Databases & query engines",
  description:
    "Storage engines, query systems, and the consistency trade-offs behind them.",
  sortOrder: 30,
};

const networking = {
  id: "networking",
  label: "Networking",
  description:
    "Protocols, routing, DNS, and the physical path between a request and a response.",
  sortOrder: 20,
};

const distributedSystems = {
  id: "distributed-systems",
  label: "Distributed systems",
  description:
    "Coordination, failure, and the machinery behind large-scale infrastructure.",
  sortOrder: 60,
};

const observability = {
  id: "observability",
  label: "Observability",
  description:
    "Metrics, tracing, logging, and what actually helps during an incident.",
  sortOrder: 100,
};

const developerTools = {
  id: "developer-tools",
  label: "Developer tools",
  description:
    "Build systems, editors, test runners, and the workflows around them.",
  sortOrder: 70,
};

const security = {
  id: "security",
  label: "Security",
  description:
    "Threat models, sandboxing, and the cryptography that guards real systems.",
  sortOrder: 50,
};

const d1Url = "https://blog.cloudflare.com/d1-control-plane/";

const d1: FixtureArticle = {
  source: {
    id: "cloudflare-blog",
    name: "Cloudflare",
    siteUrl: "https://blog.cloudflare.com/",
    host: "blog.cloudflare.com",
    feedUrl: "https://blog.cloudflare.com/rss/",
  },
  topic: databases,
  article: {
    id: "art_cloudflare_d1_control_plane",
    canonicalUrl: d1Url,
    originalTitle:
      "Under the hood, off the hot path: how D1 scales to millions of databases",
    publishedAt: "2026-10-13T16:20:18.826Z",
    discoveredAt: "2026-10-20T18:00:00.000Z",
    author: "David Laban and Lambros Petrou",
    summary:
      "Cloudflare split D1 into a control plane in Postgres and a query path that runs at the edge. The design keeps metadata, heartbeats, and billing from turning every SQL statement into a round trip to a central database.",
    slug: "d1-control-plane-millions-databases",
    status: "published",
  },
  snapshot: {
    id: "snap_cloudflare_d1_control_plane",
    sourceHash: "fixture-cloudflare-d1-control-plane-v1",
    fetchedAt: "2026-10-20T18:05:00.000Z",
    finalUrl: d1Url,
    httpStatus: 200,
    wordCount: 5027,
    blocks: [
      block(
        "b1",
        "quote",
        "The key principle for query endpoints is to avoid talking to Postgres or any other centralized single-region component.",
        d1Url,
        ["Decoupling the hot path"],
      ),
      block(
        "b2",
        "quote",
        "The write to Postgres is the “creation checkpoint” where a database is considered created even if the final response fails to reach the user.",
        d1Url,
        ["Fast on-demand database creation close to the user"],
      ),
      block(
        "b3",
        "quote",
        "Workers KV is a durable datastore, not just a cache.",
        d1Url,
        ["Decoupling the hot path"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "A million databases, one control plane out of the way",
    dek:
      "Cloudflare separates the path that runs a SQL query from the path that creates, routes, and accounts for a database. The split is less about SQLite than about keeping central Postgres out of every request.",
    oneSentence:
      "D1 keeps queries at the edge by making each database a Durable Object and using Postgres only for metadata, creation, and asynchronous accounting.",
    tldr: [
      "D1 grew 15x in live databases and 18x in daily active databases over one year, driven partly by platforms that create one database per user, tenant, or preview environment.",
      "The control plane uses Postgres for the source of truth, Workers KV for routing metadata, and Durable Objects for the databases themselves.",
      "The query path reads a mapping from KV and goes straight to the database's Durable Object. Postgres is a fallback for a KV miss, not a stop on every query.",
      "Creation is idempotent rather than transactional across systems: Postgres records the creation checkpoint, and heartbeats clean up orphaned Durable Objects and stale KV entries.",
      "Billing and row-limit accounting run through queues, pre-aggregated tables, ClickHouse, and Quicksilver so analytical work does not land on the query path.",
    ],
    sections: [
      {
        id: "one-database-per-tenant",
        title: "One database per tenant changes the shape",
        blocks: [
          p(
            r(
              "The usual database architecture assumes a small number of large clusters behind a connection pooler. Cloudflare says AI-assisted development platforms are pushing the other way: one database per user, application, preview environment, or tenant.",
              "s1",
            ),
          ),
          p(
            r(
              "That model fits D1, Cloudflare's managed SQLite service. The company reported 15x growth in live, non-deleted databases over the past year and 18x growth in daily active databases. Over two years, live databases grew 65x. The numbers are as of October 8, 2026, and they are Cloudflare's own.",
              "s1",
            ),
          ),
          p(
            r(
              "Millions of small databases create a control-plane problem. Creating, listing, deleting, importing, and exporting databases still needs a central source of truth. Running every SQL statement through that same source of truth would make the central database the bottleneck it was supposed to avoid.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "three-planes",
        title: "Three planes with different jobs",
        blocks: [
          p(
            r(
              "D1 separates three kinds of work. The control plane handles database lifecycle and account-level policy. The data plane executes SQL. The background plane accounts for storage, row usage, and cleanup.",
              "s1",
            ),
          ),
          list([
            [
              r(
                "Control plane: create, delete, list, import, export, and time-travel operations. It uses a Postgres cluster in a central region as the source of truth, with read replicas and Hyperdrive for access.",
                "s1",
              ),
            ],
            [
              r(
                "Data plane: SQL queries over the HTTP API or a Worker binding. It runs close to the user and talks to the database's Durable Object.",
                "s1",
              ),
            ],
            [
              r(
                "Background plane: storage updates, billing snapshots, row-limit checks, and orphan cleanup. It can tolerate delayed and eventually consistent data.",
                "s1",
              ),
            ],
          ]),
          p(
            r(
              "A useful design habit is to give each path its own consistency budget. A query needs the current database state. A storage total used for a soft quota can lag by seconds. A billing snapshot can lag by more. Treating all three as one consistency problem forces the strictest requirement onto the busiest path.",
            ),
          ),
        ],
      },
      {
        id: "creation-checkpoint",
        title: "Create a database without holding a transaction open",
        blocks: [
          p(
            r(
              "A creation request starts at the Edge API Worker nearest the user. That worker authenticates the request, checks entitlements, and reads the account's current database count from a Postgres read replica through Hyperdrive. The replica read is allowed to be a few seconds stale.",
              "s1",
            ),
          ),
          p(
            r(
              "The request then moves to a worker near the Postgres primary, because the rest of the flow makes several round trips to Postgres. The worker generates a database UUID and a new Durable Object ID, initializes the object with the account and database metadata, and only then writes the metadata row to Postgres.",
              "s1",
            ),
          ),
          p(
            r(
              "That Postgres write is the creation checkpoint. Once it succeeds, the database exists for every control-plane operation, even if the response never reaches the user. A final RPC tells the Durable Object it is active and asks it to update Workers KV. That final call runs in ",
              "s1",
            ),
            r("waitUntil()", undefined, { code: true }),
            r(" and is allowed to fail, because the heartbeat will repair the KV entry later.", "s1"),
          ),
          p(
            r(
              "Wrapping the whole flow in one Postgres transaction looks simpler. Cloudflare rejected it because the transaction would hold a connection while a Durable Object is initialized, possibly on another continent. At D1's scale, that design turns the transaction into a queue of held connections.",
              "s1",
            ),
          ),
          note(
            "Why retries use new IDs",
            r(
              "If a retry reused the database UUID with a fresh Durable Object, two objects could believe they own the same database. The creation loop generates a new UUID and object ID for each retry, and heartbeats delete any object whose ID never made it into Postgres.",
              "s1",
            ),
          ),
          p(
            r(
              "Each Durable Object heartbeats the control plane roughly every 30 seconds, with per-database jitter. The heartbeat reads the database's active or deleted state and the account limits. It is also the reconciliation loop for the whole creation flow: an orphaned object learns that it does not exist, and a stale KV entry is rewritten by the object that owns the database.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "query-path",
        title: "The query path treats Postgres as a fallback",
        blocks: [
          p(
            r(
              "For a SQL query over the HTTP API, the Edge API Worker authenticates the request, applies account and database rate limits, checks entitlements, and loads the database-to-Durable-Object mapping from Workers KV. If the mapping is there, the request goes to the Eyeball Worker and then to the Durable Object.",
              "s1",
            ),
          ),
          p(
            r(
              "Workers KV is doing more than caching. It is a durable store for routing metadata, so a cache eviction does not automatically send the request to Postgres. If the mapping is genuinely missing, the Edge API falls back to Hyperdrive and a Postgres read replica. Hyperdrive checks its cache near the caller and near the database before it queries the replica.",
              "s1",
            ),
          ),
          p(
            r(
              "Cloudflare chose an opaque Durable Object ID from ",
              "s1",
            ),
            r("newUniqueId()", undefined, { code: true }),
            r(
              " instead of addressing the object by name. A name would require a central name-to-ID lookup on every query. D1 would also need other metadata to choose the right Durable Object namespace, so the lookup would not even replace itself.",
              "s1",
            ),
          ),
          p(
            r(
              "The fallback has a nasty failure mode. If a million databases all lost their KV routing entries at once, a million queries would hit Postgres for metadata. Cloudflare calls that a metastable failure: the fallback path becomes the outage. Keeping KV durable is what makes the fallback rare enough to be a fallback.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "accounting-off-path",
        title: "Keep the bill out of the request path",
        blocks: [
          p(
            r(
              "Storage accounting starts when a Durable Object publishes a usage update to a queue. The control plane does not need each update synchronously, and a short delay is acceptable. A queue consumer batches the updates into a Postgres table that holds the latest size per database.",
              "s1",
            ),
          ),
          p(
            r(
              "That table is not enough for enforcement. The account total is the sum of every database's storage, and a ",
              "s1",
            ),
            r("SELECT sum(storage) ... WHERE account_id = ?", undefined, { code: true }),
            r(
              " grows linearly with the number of databases. Instead, a trigger records per-account deltas, and a scheduled job aggregates them into a single account total about once per second. The heartbeat reads that total through Hyperdrive, using the account ID as the cache key so every database on the account shares the same cached value.",
              "s1",
            ),
          ),
          p(
            r(
              "Row limits use a different path. Usage events go to ClickHouse, and a limiter queries daily sums there instead of running analytical queries against Postgres. The result is written to Quicksilver, Cloudflare's global configuration store, and the Durable Object checks that value at the edge. The enforcement decision is local; the accounting is asynchronous.",
              "s1",
            ),
          ),
          p(
            r(
              "Cloudflare accepts stale totals here: a storage or row count can be briefly behind, but a query never waits for a central aggregation query to finish. The design picks the right store for each job: Postgres for transactional metadata, ClickHouse for analytics, and KV for globally replicated routing data.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "what-transfers",
        title: "What transfers to a smaller system",
        blocks: [
          p(
            r(
              "Cloudflare's stack is specific, but the pattern travels: separate lifecycle operations from the request path, make every cross-system step retryable, keep a durable local copy of routing data, and give asynchronous accounting its own consistency budget.",
            ),
          ),
          p(
            r(
              "The pattern also has a cost. Three planes mean three failure modes, three sets of metrics, and a reconciliation loop that must be correct when one system succeeds and another fails. A system with a few hundred databases may get more value from one well-operated Postgres cluster than from a control plane that looks like D1's.",
            ),
          ),
          p(
            r(
              "One question is worth carrying to another system: what is the slowest thing this request is allowed to wait for? For a query, the answer is the database. For a storage total, the answer is a queue and a one-second aggregation. When those answers blur, the strictest path sets the latency for everything.",
            ),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "The D1 query path and its metadata fallback",
      description:
        "A query reads its routing metadata from Workers KV, then goes to the database's Durable Object. Postgres is only consulted when the KV entry is missing.",
      conceptual: true,
      nodes: [
        { id: "client", label: "Client", detail: "SQL over HTTP or a binding", cite: "s1" },
        { id: "edge", label: "Edge API", detail: "auth, limits, routing", cite: "s1" },
        { id: "kv", label: "Workers KV", detail: "durable database mapping", cite: "s1" },
        { id: "eyeball", label: "Eyeball Worker", detail: "forwards the query", cite: "s1" },
        { id: "database", label: "Durable Object", detail: "SQLite database", cite: "s1" },
        { id: "postgres", label: "Postgres", detail: "metadata fallback only", cite: "s1" },
      ],
      edges: [
        { from: "client", to: "edge", label: "query" },
        { from: "edge", to: "kv", label: "lookup mapping" },
        { from: "kv", to: "edge", label: "mapping" },
        { from: "edge", to: "eyeball", label: "forward" },
        { from: "eyeball", to: "database", label: "execute" },
        { from: "database", to: "client", label: "rows" },
        { from: "edge", to: "postgres", label: "KV miss" },
      ],
      caption:
        "The common path stays inside KV and the Durable Object. Postgres handles a missing mapping, outside the normal query path.",
    },
    eli5: {
      body: [
        p(
          r(
            "Imagine a city with millions of small storage units. The front desk keeps an index of who owns which unit, but you do not want to walk to the front desk every time you need a box. The desk gives you a durable local copy of the index, and the unit itself knows whether it is open or closed.",
          ),
        ),
        p(
          r(
            "If the local copy is missing, you can ask the front desk for the index again. The desk also sends a messenger around every 30 seconds to check that the unit still exists and that the index is correct.",
          ),
        ),
      ],
      limit:
        "The analogy hides the hard part: the local index can be stale, so the unit must still reject requests for a database that has been deleted. The Durable Object owns that final state.",
    },
    tradeoffs: [
      {
        title: "Postgres is still the source of truth",
        body:
          "Creation and deletion need one authoritative row. The heartbeat repairs drift, but it can take about 30 seconds. That is fine for routing and cleanup, and not fine for a query that needs the latest lifecycle state.",
      },
      {
        title: "Eventual consistency is a feature and a cost",
        body:
          "KV mappings and account usage totals can lag. The design uses that lag to keep central Postgres out of the request path, but it also means enforcement can be briefly behind and a deleted database can still have a stale mapping.",
      },
      {
        title: "Many small databases trade isolation for surface area",
        body:
          "Each database is cheap to create, but millions of them mean millions of heartbeats, mappings, retries, and cleanup paths. The control plane has to be idempotent at a scale where a single stuck retry loop is not a rare event.",
      },
    ],
    whenUseful: [
      "You are designing a multi-tenant platform where one account can own many small databases or indexes.",
      "You need to separate a transactional control plane from a latency-sensitive data plane.",
      "You are evaluating Cloudflare D1, Durable Objects, Workers KV, or Hyperdrive for a per-tenant data model.",
      "You want a worked example of idempotent creation across systems that cannot share a transaction.",
    ],
    caveats: [
      "This is Cloudflare's account of its own architecture, not an independent benchmark. The growth numbers are as of October 8, 2026.",
      "The design depends on Cloudflare-specific primitives: Durable Objects, Workers KV, Hyperdrive, Queues, and Quicksilver. The principles transfer more easily than the implementation.",
      "The article describes a system built for millions of databases. A smaller system may not need three planes, and adding them has real operational cost.",
      "The control plane still relies on Postgres, and the fallback path can fail. The architecture reduces the chance of a central bottleneck; it does not remove the central dependency.",
    ],
    sources: [
      {
        id: "s1",
        label: "Cloudflare: Under the hood, off the hot path",
        url: d1Url,
        note: "Cloudflare's engineering post, published October 13, 2026.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "Cloudflare D1 documentation",
        url: "https://developers.cloudflare.com/d1/",
        note: "Product documentation for D1's SQLite-backed databases and bindings.",
      },
      {
        id: "s3",
        label: "Cloudflare Durable Objects documentation",
        url: "https://developers.cloudflare.com/durable-objects/",
        note: "How Durable Objects provide single-instance coordination and durable storage.",
      },
      {
        id: "s4",
        label: "Cloudflare Hyperdrive documentation",
        url: "https://developers.cloudflare.com/hyperdrive/",
        note: "Connection pooling and caching for central databases.",
      },
      {
        id: "s5",
        label: "Cloudflare Workers KV documentation",
        url: "https://developers.cloudflare.com/kv/",
        note: "The globally distributed key-value store used for routing metadata.",
      },
    ],
    readingMinutes: 7,
    topic: "databases",
  },
};

const goHttp1Url = "https://go.dev/blog/http-connection-reuse";

const goHttp1: FixtureArticle = {
  source: {
    id: "go-blog",
    name: "The Go Blog",
    siteUrl: "https://go.dev/blog/",
    host: "go.dev",
    feedUrl: "https://go.dev/blog/feed.atom",
  },
  topic: networking,
  article: {
    id: "art_go_http1_connection_reuse",
    canonicalUrl: goHttp1Url,
    originalTitle: "Better HTTP/1 connection reuse",
    publishedAt: "2026-10-14T12:00:00.000Z",
    discoveredAt: "2026-10-20T18:00:00.000Z",
    author: "Nicholas Husin and Damien Neil",
    summary:
      "A Go HTTP/1 client can lose connection reuse by closing a response before reading the body to the end. Go 1.27 adds a bounded asynchronous drain so the simple close is enough.",
    slug: "go-http1-connection-reuse",
    status: "published",
  },
  snapshot: {
    id: "snap_go_http1_connection_reuse",
    sourceHash: "fixture-go-http1-connection-reuse-v1",
    fetchedAt: "2026-10-20T18:05:00.000Z",
    finalUrl: goHttp1Url,
    httpStatus: 200,
    wordCount: 1574,
    blocks: [
      block(
        "b1",
        "quote",
        "Through Go 1.26, when resp.Body.Close is called, net/http sees that there is still an unread response body.",
        goHttp1Url,
        ["When connection reuse fails"],
      ),
      block(
        "b2",
        "quote",
        "Starting in Go 1.27, net/http.Transport automatically does everything we have implemented in the code above: it will asynchronously drain an unread HTTP/1 response body for up to 50 ms or 256 KB.",
        goHttp1Url,
        ["The current state and conclusion"],
      ),
      block(
        "b3",
        "quote",
        "encoding/json.Decoder stops reading as soon as it sees the closing } of a JSON object.",
        goHttp1Url,
        ["Where failed connection reuse hurts"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "The unread byte that costs a TCP handshake",
    dek:
      "A Go client that closes a response without reading the body can silently lose connection reuse. Go 1.27 moves the bounded cleanup into net/http.",
    oneSentence:
      "HTTP/1 responses share one byte stream, so net/http cannot find the next response until the previous body is consumed; Go 1.27 drains a bounded amount asynchronously.",
    tldr: [
      "Reusing a connection avoids TCP and TLS handshakes. In HTTP/1, responses are sequential on one byte stream, so the client must consume a response body before the next one can start.",
      "A client that only reads the status code, or a JSON decoder that stops one newline before EOF, can leave the body unread and force net/http to abandon the connection.",
      "Go 1.27 makes Transport asynchronously drain an unread HTTP/1 body for up to 50 ms or 256 KB, so the original defer resp.Body.Close() is enough.",
      "The automatic drain is bounded on purpose. Reading a large or slow body can cost more than opening a new connection, and the behavior is HTTP/1-specific.",
    ],
    sections: [
      {
        id: "handshake-tax",
        title: "The handshake tax",
        blocks: [
          p(
            r(
              "The Go blog's opening benchmark calls a small function 100 times against index.golang.org with HTTP/1 forced on. On Go 1.26 it takes about 710 milliseconds. On Go 1.27 the same program takes about 150 milliseconds. Nothing about the request changed. The client simply stopped paying for a new connection on every call.",
              "s1",
            ),
          ),
          p(
            r(
              "A new HTTPS request over TCP starts with a TCP handshake, one round trip. Then TLS exchanges keys and verifies the server. TLS 1.2 takes two round trips; TLS 1.3 can finish in one. Only after that can the client send the HTTP request. On a cross-region link with a 100 ms round-trip time, the setup alone can cost around 300 milliseconds, while the request itself may take a little over one round trip.",
              "s1",
            ),
          ),
          p(
            r(
              "Connection reuse removes most of that setup. The client keeps the TCP and TLS state and sends the next request over the same connection. The benefit is largest when requests are small and latency is high, which describes a lot of health checks, metadata lookups, and API calls.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "sequential-stream",
        title: "Why HTTP/1 reuse is fragile",
        blocks: [
          p(
            r(
              "HTTP/1.1 connections are persistent by default. Either side can send a ",
              "s1",
            ),
            r("Connection: close", undefined, { code: true }),
            r(
              " header to end reuse, but absent that, the connection can carry many request and response pairs. HTTP/2 goes further and multiplexes multiple streams over one connection, but HTTP/1 sends responses back-to-back on a single stream.",
              "s1",
            ),
          ),
          p(
            r(
              "When ",
              "s1",
            ),
            r("net/http.Get", undefined, { code: true }),
            r(
              " reads a response, it parses the status line and headers, fills in the Response, and returns. The body is still sitting on the connection, waiting for the caller to read it. Until the body reaches its end, as defined by Content-Length or the chunked transfer encoding, the client cannot know where the next response begins.",
              "s1",
            ),
          ),
          p(
            r(
              "If the caller closes the body before that point, net/http sees an unread body and concludes that the connection cannot be reused. It abandons the connection and opens a new one for the next request. The caller sees a successful request and never learns that reuse was lost.",
              "s1",
            ),
          ),
          p(
            r(
              "HTTP/2 does not have this problem. An unread body on one stream does not block other requests from sharing the connection, because the streams are multiplexed rather than sent strictly one after another. That is also why draining an HTTP/2 body to improve reuse is unnecessary.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "one-byte-short",
        title: "The newline that breaks reuse",
        blocks: [
          p(
            r(
              "The simplest version of the bug is a client that only wants the status code. The server still sends a body, maybe ",
              "s1",
            ),
            r('{"success": true, "message": "update processed"}', undefined, { code: true }),
            r(
              ". The client reads the headers, returns the status, and closes. The body was never consumed, so the connection is discarded.",
              "s1",
            ),
          ),
          codeBlock(),
          p(
            r(
              "A subtler version happens in code that does read the body. ",
              "s1",
            ),
            r("encoding/json.Decoder", undefined, { code: true }),
            r(
              " stops as soon as it sees the closing brace of a JSON object. If the server terminates the response with a newline, that newline is still unread. The connection is one byte away from being reusable, and the decoder has no reason to read it.",
              "s1",
            ),
          ),
          p(
            r(
              "The code looks correct: it checks the error, defers Close, and returns the value it needs, which is why the bug is easy to miss in review. The cost shows up later as extra handshakes, higher tail latency, and more connections in the pool than the request rate suggests.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "manual-workarounds",
        title: "The manual workarounds",
        blocks: [
          p(
            r(
              "Before Go 1.27, the usual fix was to drain the body before closing it. ",
              "s1",
            ),
            r("io.Copy(io.Discard, body)", undefined, { code: true }),
            r(
              " reads to EOF and lets net/http reuse the connection. That works for small responses, but it can be worse than a new connection if the unread body is large: the client downloads and throws away the rest of the payload just to avoid a handshake.",
              "s1",
            ),
          ),
          p(
            r(
              "A better workaround caps the drain at 256 KB and gives it 50 milliseconds. If the body is larger or slower, the client closes and accepts a new connection. The async version runs the drain in the background and lets it race the next request, which avoids blocking the caller for the full timeout.",
              "s1",
            ),
          ),
          p(
            r(
              "The workaround is easy to get subtly wrong. A naïve goroutine can leak if Close does not interrupt the copy. A timeout can add latency to every close. And because the practice spread without its context, some developers started draining HTTP/2 bodies, where the original problem does not exist.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "go-127",
        title: "What Go 1.27 changes",
        blocks: [
          p(
            r(
              "Go 1.27 moves the bounded drain into ",
              "s1",
            ),
            r("net/http.Transport", undefined, { code: true }),
            r(
              ". When an HTTP/1 response body is closed unread, Transport asynchronously drains up to 256 KB for up to 50 milliseconds. If the drain finishes in time, the connection can be reused. If it does not, the body is closed and the next request may need a new connection.",
              "s1",
            ),
          ),
          p(
            r(
              "Transport also skips the drain when the response carries ",
              "s1",
            ),
            r("Connection: close", undefined, { code: true }),
            r(
              ", because the connection cannot be reused anyway. The Go team says the behavior may evolve as more optimizations become possible, so the exact thresholds are an implementation detail, not a contract.",
              "s1",
            ),
          ),
          p(
            r(
              "The recommended pattern is now the original one: read the response you need, then ",
              "s1",
            ),
            r("defer resp.Body.Close()", undefined, { code: true }),
            r(
              ". The standard library handles the cleanup. A caller should still read a body it needs, and a huge response is still expensive to discard, but the common case no longer requires a hand-written drain.",
              "s1",
            ),
          ),
          note(
            "One benchmark, one machine",
            r(
              "The 710 ms to 150 ms result is one program, one endpoint, and one machine. It shows the size of the handshake cost when reuse fails. Your own latency depends on RTT, TLS version, connection pool settings, and server behavior.",
              "s1",
            ),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "Why an unread body throws away the connection",
      description:
        "The client reads headers and returns before the body is consumed. Closing the body then forces net/http to abandon the connection and pay for a new handshake.",
      conceptual: true,
      nodes: [
        { id: "request", label: "GET request", detail: "send on a connection", cite: "s1" },
        { id: "headers", label: "Headers parsed", detail: "Response returned", cite: "s1" },
        { id: "body", label: "Body unread", detail: "still on the stream", cite: "s1" },
        { id: "close", label: "Close", detail: "body not at EOF", cite: "s1" },
        { id: "new", label: "New connection", detail: "TCP and TLS again", cite: "s1" },
        { id: "reuse", label: "Reused connection", detail: "next request is cheap", cite: "s1" },
      ],
      edges: [
        { from: "request", to: "headers", label: "response" },
        { from: "headers", to: "body", label: "caller reads" },
        { from: "body", to: "close", label: "close early" },
        { from: "close", to: "new", label: "abandon" },
        { from: "body", to: "reuse", label: "read to EOF" },
        { from: "new", to: "request", label: "next request" },
      ],
      caption:
        "HTTP/1 responses are sequential. The next response cannot start until the previous body is consumed, so an early close costs a full new connection.",
    },
    eli5: {
      body: [
        p(
          r(
            "HTTP/1 is a single conveyor belt. The client reads the label at the start of a package and walks away. The next package cannot be put on the belt until the first one is taken off, so the belt is shut down and a new one is built.",
          ),
        ),
        p(
          r(
            "Go 1.27 sends a helper to clear a small amount of the belt before shutting it down. If the package is small, the belt keeps running. If it is large or slow, the helper gives up and the client builds a new belt.",
          ),
        ),
      ],
      limit:
        "The helper only clears a bounded amount. It is not a reason to ignore a large response body you need, and it does not apply to HTTP/2.",
    },
    tradeoffs: [
      {
        title: "Draining can cost more than a handshake",
        body:
          "Reading a huge or slow body just to reuse a connection can be worse than opening a new one. The 256 KB and 50 ms caps are a compromise, not a universal answer.",
      },
      {
        title: "Automatic cleanup hides background work",
        body:
          "The drain runs asynchronously, so it improves reuse without blocking the caller. It still consumes CPU, bandwidth, and a goroutine for a short time, and it can race the next request.",
      },
      {
        title: "HTTP/2 changes the failure mode",
        body:
          "With HTTP/2, an unread body on one stream does not block other streams. Flow control and stream limits still matter, but draining the body for connection reuse is the wrong fix.",
      },
    ],
    whenUseful: [
      "You maintain a Go service that makes many small HTTP/1 requests to the same host.",
      "You are debugging latency, connection churn, or pool exhaustion that does not match the request rate.",
      "You write API clients that only inspect status codes or decode a single JSON object per response.",
      "You are upgrading to Go 1.27 and want to remove a hand-written drain helper.",
    ],
    caveats: [
      "The benchmark is one machine and one endpoint. Treat it as a demonstration of the mechanism, not a forecast for your service.",
      "Go 1.27's drain behavior may change in later releases. The article describes a snapshot of the implementation.",
      "Connection reuse also depends on server headers, idle timeouts, proxy behavior, and connection pool settings.",
      "The automatic drain is only for HTTP/1. HTTP/2 and HTTP/3 have different multiplexing and flow-control behavior.",
    ],
    sources: [
      {
        id: "s1",
        label: "The Go Blog: Better HTTP/1 connection reuse",
        url: goHttp1Url,
        note: "Nicholas Husin and Damien Neil, published October 14, 2026.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "RFC 9112: HTTP/1.1",
        url: "https://www.rfc-editor.org/rfc/rfc9112.html",
        note: "The HTTP/1.1 message syntax and connection management rules.",
      },
      {
        id: "s3",
        label: "Go net/http package documentation",
        url: "https://pkg.go.dev/net/http",
        note: "Client, Transport, Response, and connection reuse behavior.",
      },
      {
        id: "s4",
        label: "Go 1.27 release notes",
        url: "https://go.dev/doc/go1.27",
        note: "The release that includes the automatic HTTP/1 drain.",
      },
    ],
    readingMinutes: 5,
    topic: "networking",
  },
};

function codeBlock(): Block {
  return {
    type: "code",
    language: "go",
    code:
      "func getStatus(url string) (int, error) {\n\tresp, err := http.Get(url)\n\tif err != nil {\n\t\treturn 0, err\n\t}\n\tdefer resp.Body.Close()\n\treturn resp.StatusCode, nil\n}",
    caption:
      "The original example. It reads the status line and headers, then closes a body that net/http has not finished with.",
  };
}

const etcdUrl =
  "https://developers.redhat.com/articles/2026/10/13/sharding-etcd-on-hosted-control-planes-and-what-the-numbers-actually-say";

const etcd: FixtureArticle = {
  source: {
    id: "red-hat-developers",
    name: "Red Hat Developers",
    siteUrl: "https://developers.redhat.com/",
    host: "developers.redhat.com",
  },
  topic: distributedSystems,
  article: {
    id: "art_red_hat_etcd_sharding",
    canonicalUrl: etcdUrl,
    originalTitle:
      "Sharding etcd on hosted control planes and what the numbers actually say",
    publishedAt: "2026-10-13T13:17:03.000Z",
    discoveredAt: "2026-10-20T18:00:00.000Z",
    author: "Vishnu Challa",
    summary:
      "Red Hat measured a two-shard etcd topology on hosted control planes. Event storms improved sharply, while memory use rose and a large custom-resource workload regressed.",
    slug: "etcd-sharding-hosted-control-planes",
    status: "published",
  },
  snapshot: {
    id: "snap_red_hat_etcd_sharding",
    sourceHash: "fixture-red-hat-etcd-sharding-v1",
    fetchedAt: "2026-10-20T18:05:00.000Z",
    finalUrl: etcdUrl,
    httpStatus: 200,
    wordCount: 2718,
    blocks: [
      block(
        "b1",
        "quote",
        "The short version is that under event pressure, sharding is a clear win.",
        etcdUrl,
        ["The results"],
      ),
      block(
        "b2",
        "quote",
        "It costs roughly 1.8 to 2.3x the etcd container memory",
        etcdUrl,
        ["The results"],
      ),
      block(
        "b3",
        "quote",
        "compaction there took about 51% longer, and its growth rate was 85% longer.",
        etcdUrl,
        ["Sharding loses on DB quota pressure"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "Sharding etcd only pays off in the right storm",
    dek:
      "Red Hat split a hosted control plane's etcd into a main shard and an events shard. Event storms got faster, but memory use rose and one large-object workload got worse.",
    oneSentence:
      "Sharding etcd by resource kind isolates high-volume, low-value events from cluster state, cutting slow applies by up to 96% while roughly doubling etcd memory.",
    tldr: [
      "Red Hat tested one etcd against two etcd shards, one for cluster state and one for events, on identical OpenShift 4.21 and HyperShift hardware.",
      "During a 200,000-event storm, slow applies fell from a mean of 281 to 11.5 on the main shard, a 96% reduction, and throughput rose.",
      "The realistic crashloop test also improved: p99 backend commit latency fell from 24.5 ms to 18.7 ms and compaction from 17.6 s to 5.64 s.",
      "The cost was roughly 1.8x to 2.3x the etcd container memory. A workload that filled the main shard with large custom resources saw compaction take 51.5% longer.",
      "This is a tech preview and a representative run, not capacity-planning guidance. The result depends on the workload mix and the shard layout.",
    ],
    sections: [
      {
        id: "shared-write-path",
        title: "The shared write path",
        blocks: [
          p(
            r(
              "Every write to a Kubernetes cluster ends up in etcd's write-ahead log, then its backend, then its compaction cycle. On a hosted control plane, those writes compete with each other even though they serve very different purposes.",
              "s1",
            ),
          ),
          p(
            r(
              "Event objects are the obvious mismatch. They are high-volume, short-lived, and mostly diagnostic. A single misbehaving controller or a few thousand crashlooping pods can push enough events through etcd to slow down the Deployments, Secrets, and other objects that define the cluster.",
              "s1",
            ),
          ),
          p(
            r(
              "etcd does not know that an event is less important than a Secret. Every object shares the same WAL fsyncs, backend commits, and compaction passes. Sharding by resource kind gives the high-volume, low-value traffic its own etcd, so a storm in one kind does not have to slow the objects in another.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "test-setup",
        title: "The test setup",
        blocks: [
          p(
            r(
              "Red Hat ran the tests on identical hardware in AWS us-west-2, on the same OpenShift 4.21 build, with hosted control planes managed by HyperShift. The only variable was the etcd topology.",
              "s1",
            ),
          ),
          list([
            [
              r(
                "Management cluster: three control-plane and three worker nodes (m6i.xlarge, 4 vCPU / 16 GiB) plus three infrastructure nodes (r5.xlarge, 4 vCPU / 32 GiB) for monitoring.",
                "s1",
              ),
            ],
            [
              r(
                "Hosted cluster: 24 worker nodes (m5.xlarge, 4 vCPU / 16 GiB), EBS-only storage, up to 10 Gbps network.",
                "s1",
              ),
            ],
            [
              r(
                "Standard arm: one etcd instance for the whole hosted control plane. Sharded arm: two etcd instances, a main shard and an events shard.",
                "s1",
              ),
            ],
            [
              r(
                "Samples: three runs per arm per workload, with four workload variants. The published numbers are from one representative run.",
                "s1",
              ),
            ],
          ]),
          p(
            r(
              "The four workloads were chosen to stress different parts of the write path: synthetic events alongside real deployments, a realistic crashloop flood, large custom resources that press against the database quota, and rapid annotation churn on ConfigMaps. The workloads ship in ",
              "s1",
            ),
            r("kube-burner-ocp", undefined, { code: true }),
            r(
              ", the same tooling the OpenShift performance team uses for control-plane tests.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "event-storm",
        title: "The event storm results",
        blocks: [
          p(
            r(
              "The event-storm test creates 200,000 synthetic Event objects of about 1 KiB each across 20 parallel workers. While that runs, a victim workload deploys 900 iterations of two Deployments, three ConfigMaps, and a Service. The victim workload measures what the storm does to ordinary cluster operations.",
              "s1",
            ),
          ),
          p(
            r(
              "The split did what it promised. About 26,000 keys moved to the events shard. The standard arm performed 55,386 WAL fsyncs, while the sharded arm performed 42,251 on the main shard and 46,560 on the events shard, for 88,811 combined. That is 60% more write operations for the same workload. Backend commits followed the same pattern: 3,790 standard versus 7,188 combined, a 90% increase.",
              "s1",
            ),
          ),
          p(
            r(
              "The main shard also got faster. Its fsync duration fell 21.6%, backend commit duration fell 12.8%, mean compaction fell from 1.06 seconds to 597 milliseconds, and raft snapshot duration fell from 134 microseconds to 64.9 microseconds. The events shard handled its own work with a 49.8 ms fsync duration and no slow applies.",
              "s1",
            ),
          ),
          p(
            r(
              "The clearest result is slow applies. The standard arm averaged 281 and peaked at 1,499. The sharded main shard averaged 11.5 and peaked at 57.3, a 96% reduction, while the events shard recorded none. Pod-ready latency and workload finish times stayed comparable, and the standard arm occasionally failed the workload outright while the sharded arm did not.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "realistic-patterns",
        title: "Crashloops and annotation churn",
        blocks: [
          p(
            r(
              "Synthetic events are a clean signal but not a realistic one. Real event storms are dominated by kubelet, scheduler, and controller events, including PATCH operations that increment an event's count field rather than creating a new key. That produces a different MVCC profile.",
              "s1",
            ),
          ),
          p(
            r(
              "The crashloop test runs 2,000 crashlooping pods across 20 namespaces, with about six events per crash cycle and a ten-minute soak. The improvement survived: p99 backend commit latency fell from 24.5 ms to 18.7 ms, mean compaction fell from 17.6 seconds to 5.64 seconds, and peak fragment size fell from 206 MiB to 160 MiB. Neither arm recorded write failures, and pending raft proposals stayed lower in the sharded arm.",
              "s1",
            ),
          ),
          p(
            r(
              "Annotation churn produced a more modest win. The test rapidly merge-patches annotations on 500 ConfigMaps, building hundreds of revisions per key. Mean compaction fell from 3.74 seconds to 2.25 seconds, a 39.8% reduction, and the compaction growth rate fell 37.2%. Neither arm recorded a slow operation. The main benefit is that compaction no longer has to process event revisions and annotation revisions in the same pass.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "memory-and-bad-case",
        title: "The memory bill and the bad case",
        blocks: [
          p(
            r(
              "Two etcd processes use more memory than one. The size of the gap is the surprise. In the event-storm run, the single etcd container peaked around 361 MiB. The two sharded containers came to about 642 MiB combined, roughly 78% more. In annotation churn, the gap widened from 183 MiB to 420 MiB, about 2.3x.",
              "s1",
            ),
          ),
          p(
            r(
              "The extra memory does not appear to be stored data. Database size, key counts, and fragment totals track the split as expected. Red Hat's working hypothesis is a per-container floor rather than a per-shard cost, which would make the overhead roughly constant instead of scaling with the number of shards. That hypothesis is not confirmed.",
              "s1",
            ),
          ),
          p(
            r(
              "The bad case is a database filled with large custom resources. The test creates 4,500 namespaces, each holding eight 100 KB objects, for about 3.5 GB in the main shard. Compaction there took 1.65 minutes in the standard arm and 2.50 minutes in the sharded arm, a 51.5% increase. The compaction growth rate rose 85.4%.",
              "s1",
            ),
          ),
          p(
            r(
              "The page-fault rate was nearly identical between arms, 924 per second versus 935 per second, so the data does not prove the memory-pressure explanation. Red Hat calls the regression an open investigation, not a characterized limitation. It only appeared when deploying large custom resources at scale with a dedicated events shard.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "when-worth-it",
        title: "When sharding might be worth it",
        blocks: [
          p(
            r(
              "The profile that benefits is a hosted control plane with a lot of event traffic that is not equally important: CI and build farms, crashlooping workloads, controller-heavy clusters, and annotation churn. In those cases, isolating events protects the writes that keep the cluster healthy.",
              "s1",
            ),
          ),
          p(
            r(
              "It is not a default recommendation. The feature is in tech preview, the test used one representative run per workload, and the memory cost is real. Red Hat also still needs to test what happens when the event shard's storage quota fills, and whether multi-shard layouts with leases, secrets, and ConfigMaps behave the same way.",
              "s1",
            ),
          ),
          p(
            r(
              "A narrower lesson applies: find the traffic that competes with your critical writes, measure whether separating it helps, and include the second process's memory and failure modes in the comparison. A shard is a new etcd with its own memory, quota, and failure modes.",
              "s1",
            ),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "What the etcd split moves, and what it costs",
      description:
        "Events leave the main etcd for a dedicated shard. The main shard handles cluster state with fewer slow applies, while the second process adds memory overhead.",
      conceptual: true,
      nodes: [
        { id: "storm", label: "Event storm", detail: "high volume, short lived", cite: "s1" },
        { id: "single", label: "Single etcd", detail: "all keys share one WAL", cite: "s1" },
        { id: "wal", label: "WAL and compaction", detail: "fsync, commit, compact", cite: "s1" },
        { id: "slow", label: "Slow applies", detail: "cluster state waits", cite: "s1" },
        { id: "main", label: "Main shard", detail: "Deployments, Secrets", cite: "s1" },
        { id: "events", label: "Events shard", detail: "diagnostic traffic", cite: "s1" },
        { id: "memory", label: "Memory cost", detail: "about 1.8x to 2.3x", cite: "s1" },
        { id: "result", label: "Fewer slow applies", detail: "up to 96% fewer", cite: "s1" },
      ],
      edges: [
        { from: "storm", to: "single", label: "before" },
        { from: "single", to: "wal", label: "all writes" },
        { from: "wal", to: "slow", label: "contention" },
        { from: "storm", to: "events", label: "after" },
        { from: "main", to: "result", label: "cluster state" },
        { from: "events", to: "result", label: "isolated" },
        { from: "main", to: "memory", label: "second process" },
        { from: "events", to: "memory", label: "second process" },
      ],
      caption:
        "The split gives events their own etcd and leaves cluster state on the main shard. The trade is a second process, roughly 1.8x to 2.3x memory, and one workload where compaction regressed.",
    },
    eli5: {
      body: [
        p(
          r(
            "Think of etcd as one checkout line that handles both quick receipt checks and real purchases. A crowd of people with receipts can make the paying customers wait. Sharding opens a separate express lane for receipts.",
          ),
        ),
        p(
          r(
            "The main line moves faster, but you now pay for another cashier and another till. If the back room fills with large items that must stay in the main line, the extra till does not help, and the main line can even get slower.",
          ),
        ),
      ],
      limit:
        "The express lane only helps when the extra traffic is the kind you can separate. It is also a second etcd with its own memory, quota, and failure modes.",
    },
    tradeoffs: [
      {
        title: "Isolation buys latency, costs memory",
        body:
          "The event shard keeps diagnostic traffic away from cluster state. It also adds a second etcd process, and the measured memory overhead was 1.8x to 2.3x in the workloads where it appeared.",
      },
      {
        title: "Sharding is not free in every workload",
        body:
          "Large custom resources stayed in the main shard and compaction regressed by 51.5%. The cause is still under investigation, which is a reason to test your own object sizes and revision patterns.",
      },
      {
        title: "A tech preview is not a capacity plan",
        body:
          "The results come from three runs per arm and one representative run per chart. The hardware, workload mix, and OpenShift version are specific. Use the workloads to reproduce the test, not the headline to size a cluster.",
      },
    ],
    whenUseful: [
      "You operate hosted Kubernetes control planes and see event traffic crowding out cluster-state writes.",
      "You are planning etcd capacity for CI, build-farm, or crashloop-heavy clusters.",
      "You want a measured example of isolating high-volume, low-value objects by resource kind.",
      "You are evaluating the memory and failure-mode cost of a second etcd process.",
    ],
    caveats: [
      "This is a Red Hat tech preview, not a generally available feature. The company says the results are not capacity-planning guidance.",
      "The numbers come from one representative run per workload, with three runs per arm. Variance and tail behavior are not fully characterized.",
      "The large-custom-resource regression is unexplained. The page-fault data does not establish the memory-pressure hypothesis.",
      "The test did not cover an event shard filling its quota or a multi-shard layout with leases, secrets, and ConfigMaps.",
    ],
    sources: [
      {
        id: "s1",
        label: "Red Hat Developers: Sharding etcd on hosted control planes",
        url: etcdUrl,
        note: "Vishnu Challa, published October 13, 2026.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "etcd maintenance documentation",
        url: "https://etcd.io/docs/v3.5/op-guide/maintenance/",
        note: "Compaction, defragmentation, and the maintenance operations referenced in the article.",
      },
      {
        id: "s3",
        label: "kube-burner-ocp",
        url: "https://github.com/kube-burner/kube-burner-ocp",
        note: "The workload tool used for the etcd-density tests.",
      },
      {
        id: "s4",
        label: "HyperShift",
        url: "https://github.com/openshift/hypershift",
        note: "The hosted control plane project used in the test environment.",
      },
    ],
    readingMinutes: 6,
    topic: "distributed-systems",
  },
};

const minervaUrl =
  "https://innovation.ebayinc.com/stories/inside-minerva-building-scalable-observability-for-ebays-monetization-platform/";

const minerva: FixtureArticle = {
  source: {
    id: "ebay-engineering",
    name: "eBay Engineering",
    siteUrl: "https://innovation.ebayinc.com/",
    host: "innovation.ebayinc.com",
  },
  topic: observability,
  article: {
    id: "art_ebay_minerva_observability",
    canonicalUrl: minervaUrl,
    originalTitle:
      "Inside Minerva: building scalable observability for eBay’s monetization platform",
    publishedAt: "2026-10-14T12:00:00.000Z",
    discoveredAt: "2026-10-20T18:00:00.000Z",
    author: "Gautam Singh, Ravi Agarwal, and Akshay Kamath",
    summary:
      "eBay's Minerva keeps fee monitoring off the transaction path with a bounded local queue, asynchronous enrichment, ClickHouse history, and configurable alert evaluation.",
    slug: "ebay-minerva-fee-observability",
    status: "published",
  },
  snapshot: {
    id: "snap_ebay_minerva_observability",
    sourceHash: "fixture-ebay-minerva-observability-v1",
    fetchedAt: "2026-10-20T18:05:00.000Z",
    finalUrl: minervaUrl,
    httpStatus: 200,
    wordCount: 1664,
    blocks: [
      block(
        "b1",
        "quote",
        "The fee-processing service records the fee decision and enqueues only the identifiers needed for monitoring.",
        minervaUrl,
        ["Keeping observability off the real-time fee-processing path"],
      ),
      block(
        "b2",
        "quote",
        "This behavior deliberately prioritizes fee-processing availability over lossless monitoring delivery.",
        minervaUrl,
        ["Keeping observability off the real-time fee-processing path"],
      ),
      block(
        "b3",
        "quote",
        "ClickHouse stores data by column, allowing a query to read the fields it needs rather than every attribute in every row.",
        minervaUrl,
        ["Making fee history queryable"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "Observability that stays off the money path",
    dek:
      "eBay's Minerva records a small fee decision locally, enriches it asynchronously, stores the history in ClickHouse, and evaluates alerts without adding a remote call to fee processing.",
    oneSentence:
      "Minerva separates making a fee decision from explaining it, using a bounded local queue and an asynchronous pipeline so monitoring cannot slow down billing.",
    tldr: [
      "Fee processing writes only the identifiers it needs for monitoring to a local queue. A background producer publishes them later, so the request does not wait on a broker or analytical store.",
      "The queue is bounded by capacity and age and can drop or overwrite records. eBay chose fee-processing availability over lossless monitoring delivery.",
      "A consumer enriches the record from transactional stores, and ClickHouse stores the resulting history for repeated scans across millions of rows with roughly 250 columns.",
      "Monitoring runs as three modules: query execution, use-case processing, and notification delivery. New use cases do not require changing the fee service or the ingestion pipeline.",
    ],
    sections: [
      {
        id: "why-totals-are-not-enough",
        title: "Why aggregate fee totals are not enough",
        blocks: [
          p(
            r(
              "eBay reported $22.4 billion in gross merchandise volume, 136 million active buyers, and 2.6 billion active listings in the second quarter of 2026. Pricing, promotions, and subscriptions depend on roughly 200 item, seller, marketplace, and campaign attributes.",
              "s1",
            ),
          ),
          p(
            r(
              "At that scale, a global fee total can look normal while one site, fee type, promotion, or time period behaves badly. The reverse is also true: a sharp change can be expected because a promotion expired or a rollout changed traffic. Monitoring has to preserve enough dimensions to answer both what changed and why.",
              "s1",
            ),
          ),
          p(
            r(
              "Observability asks a different question from transactional correctness. The fee service has to calculate and charge the right amount. An observability system has to retain the context around that decision long enough for a person to investigate it.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "old-gap",
        title: "The gap before Minerva",
        blocks: [
          p(
            r(
              "The previous setup had three practical problems. Data in the warehouse arrived too late for launch monitoring, and it usually lived in a different security zone. Investigations required engineers to query multiple sources and assemble comparisons by hand. Problems were often discovered through customer complaints or post-transaction analysis, hours or days after the fee was charged.",
              "s1",
            ),
          ),
          p(
            r(
              "A daily view can confirm an issue after the fact. It cannot tell an operator watching a fee rollout whether the last hour is normal. Minerva was built to close that gap without becoming a new dependency for the service that calculates fees.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "local-queue",
        title: "Keep monitoring off the critical path",
        blocks: [
          p(
            r(
              "Publishing directly to a remote event stream from a fee-processing request would tie monitoring availability to fee availability. A slow network call, an unavailable broker, or downstream backpressure could add latency or consume resources that production traffic needs.",
              "s1",
            ),
          ),
          p(
            r(
              "Minerva instead places a small record on a local queue. The record contains identifiers for the item and the fee-calculation event, not the full context. A background producer drains the queue and publishes each record to the event stream. Under normal conditions, the request does not wait for publication, enrichment, analytical storage, or alert evaluation.",
              "s1",
            ),
          ),
          p(
            r(
              "The queue absorbs short delays, but it is not unlimited. If the producer cannot drain it for long enough, the backlog can consume resources and affect the fee service. Minerva bounds the queue by capacity and record age. Records that cannot be processed within a configured interval can be flushed or overwritten, following a ring-buffer policy.",
              "s1",
            ),
          ),
          note(
            "A deliberate gap",
            r(
              "The event stream is not the transactional source of truth. A prolonged downstream outage can leave a hole in monitoring data, but it cannot change or invalidate the original fee calculation. eBay accepts that gap to keep the fee path independent.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "enrich-and-store",
        title: "Enrich later, store for scans",
        blocks: [
          p(
            r(
              "The initial record contains only identifiers. A background consumer uses them to query the transaction read database and retrieve the fee, listing, account, and promotion attributes. The enriched record can then serve dashboards and monitoring queries without joining multiple operational stores on every read.",
              "s1",
            ),
          ),
          p(
            r(
              "This makes monitoring eventually consistent. The data appears after the fee decision, not during it. The fee request stays isolated from the analytical work, and the monitoring pipeline can lag without putting the transaction path at risk.",
              "s1",
            ),
          ),
          p(
            r(
              "ClickHouse stores the history. Minerva's common queries aggregate a small set of fields, such as fee amount, site, fee type, promotion, and time, across millions of records that each have almost 250 columns. A columnar store reads only the fields a query needs. The MergeTree family also provides ordering and partitioning controls that can be aligned with common access patterns.",
              "s1",
            ),
          ),
          p(
            r(
              "An early proof of concept tested about 1.1 billion listing-session rows on a machine with six virtual CPUs and 44 GB of memory. Sample lookups and aggregations finished in under a second, with reported examples from about 0.11 to 0.72 seconds. The article is careful about the limits: there were no repeated runs, cache-state controls, concurrency tests, compression measurements, or baseline comparison. It established feasibility, not a production benchmark.",
              "s1",
            ),
          ),
          p(
            r(
              "The first data model organized records around listing-session and account-event identifiers and collected fee, currency, transaction, listing, and promotion attributes during ingestion. That reduced the need to rebuild each business event from operational stores during every investigation. Minerva consumes upstream fee and promotion decisions rather than recalculating them, so its job is to observe outcomes rather than become a second pricing engine.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "signals",
        title: "From stored history to signals",
        blocks: [
          p(
            r(
              "The original monitoring service divides the work into three modules. Query execution identifies eligible queries, checks their cadence, and coordinates multiple monitoring instances so only one evaluates each scheduled query. When a use case depends on several queries, processing waits until the required result sets are available.",
              "s1",
            ),
          ),
          p(
            r(
              "The use-case processor applies the logic for each signal. One processor might calculate a fee-amount deviation. Another might compare transaction count by site and hour. A third could combine fee and promotion data to interpret a spike. The processor evaluates the metric, assigns severity, and creates a notification model with supporting context.",
              "s1",
            ),
          ),
          p(
            r(
              "The notification module selects the destination and builds a payload for PagerDuty, email, or Slack. Settings can be broad and then overridden for a rule or data segment. A high-severity country-level fee deviation can go to PagerDuty while a lower-severity trend goes by email. New use cases can be added without changing the fee service or the ingestion pipeline.",
              "s1",
            ),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "Minerva keeps the fee request away from the analytics path",
      description:
        "The fee service writes identifiers to a local bounded queue. A background pipeline publishes, enriches, stores in ClickHouse, evaluates, and notifies.",
      conceptual: true,
      nodes: [
        { id: "fee", label: "Fee service", detail: "calculates and charges", cite: "s1" },
        { id: "queue", label: "Local queue", detail: "bounded by age and size", cite: "s1" },
        { id: "producer", label: "Producer", detail: "drains in background", cite: "s1" },
        { id: "stream", label: "Event stream", detail: "monitoring records", cite: "s1" },
        { id: "enrich", label: "Enricher", detail: "reads transaction context", cite: "s1" },
        { id: "clickhouse", label: "ClickHouse", detail: "history for scans", cite: "s1" },
        { id: "monitor", label: "Monitoring", detail: "queries and use cases", cite: "s1" },
        { id: "notify", label: "Notification", detail: "PagerDuty, email, Slack", cite: "s1" },
      ],
      edges: [
        { from: "fee", to: "queue", label: "identifiers" },
        { from: "queue", to: "producer", label: "drain" },
        { from: "producer", to: "stream", label: "publish" },
        { from: "stream", to: "enrich", label: "consume" },
        { from: "enrich", to: "clickhouse", label: "batch write" },
        { from: "clickhouse", to: "monitor", label: "query" },
        { from: "monitor", to: "notify", label: "signal" },
      ],
      caption:
        "The request path ends at the local queue. Everything after that can lag, drop records, or fail without changing the fee decision.",
    },
    eli5: {
      body: [
        p(
          r(
            "A cashier prints a tiny receipt with an order number and drops it in a tray. A worker later pulls the receipt, looks up the order details, files it in a warehouse, and raises a flag if the totals look wrong. The cashier never waits for the warehouse.",
          ),
        ),
        p(
          r(
            "The tray has a fixed size. If the warehouse is down for too long, old receipts can be thrown away or overwritten. The sale still happened, but the monitoring record may have a gap.",
          ),
        ),
      ],
      limit:
        "The tray is deliberately bounded. Minerva chooses available fee processing over complete monitoring, so a long outage can leave holes in the history.",
    },
    tradeoffs: [
      {
        title: "Lossless monitoring versus available billing",
        body:
          "A bounded local queue can drop or overwrite records during a long downstream failure. That is acceptable because monitoring is not the source of truth, but it means an incident can also create blind spots.",
      },
      {
        title: "ClickHouse is for scans, not transactions",
        body:
          "Columnar storage and MergeTree ordering make repeated historical aggregations practical. They do not make ClickHouse the fee ledger, and the monitoring data is eventually consistent with the transaction database.",
      },
      {
        title: "More context means more ingestion cost",
        body:
          "The record carries about 250 columns because investigators need item, seller, marketplace, and campaign context. Collecting that context at ingestion makes later scans cheaper but increases what the pipeline must store.",
      },
    ],
    whenUseful: [
      "You need observability for a high-volume transactional system without adding a remote dependency to the request path.",
      "You are designing an asynchronous enrichment pipeline and need to decide what can be dropped during backpressure.",
      "You are evaluating ClickHouse for repeated historical aggregations over wide records.",
      "You want a concrete example of separating signal detection from notification delivery.",
    ],
    caveats: [
      "This is a vendor case study. The architecture and numbers come from eBay, not an independent evaluation.",
      "The ClickHouse proof of concept was not a production benchmark. It did not record repeated runs, cache state, concurrency, compression, or a baseline.",
      "The article does not describe the full operational cost of running the pipeline, including queue tuning, enrichment failure handling, and ClickHouse operations.",
      "Dropping monitoring records is a deliberate policy, so the system can have gaps during a prolonged outage.",
    ],
    sources: [
      {
        id: "s1",
        label: "eBay: Inside Minerva",
        url: minervaUrl,
        note: "Gautam Singh, Ravi Agarwal, and Akshay Kamath, published October 14, 2026.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "ClickHouse MergeTree documentation",
        url: "https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/mergetree",
        note: "The table engine family used for ordered and partitioned analytical storage.",
      },
      {
        id: "s3",
        label: "ClickHouse documentation",
        url: "https://clickhouse.com/docs/en/intro",
        note: "Column-oriented storage and analytical query behavior.",
      },
    ],
    readingMinutes: 5,
    topic: "observability",
  },
};

const goplsUrl = "https://go.dev/blog/interactive-refactoring";

const gopls: FixtureArticle = {
  source: {
    id: "go-blog",
    name: "The Go Blog",
    siteUrl: "https://go.dev/blog/",
    host: "go.dev",
    feedUrl: "https://go.dev/blog/feed.atom",
  },
  topic: developerTools,
  article: {
    id: "art_go_gopls_interactive_refactoring",
    canonicalUrl: goplsUrl,
    originalTitle: "Interactive refactoring in gopls",
    publishedAt: "2026-10-16T12:00:00.000Z",
    discoveredAt: "2026-10-20T18:00:00.000Z",
    author: "Hongxiang Jiang",
    summary:
      "gopls can now ask the editor for input before it computes a refactoring. The new LSP capability turns parameterless code actions into multi-step dialogs for tags, interfaces, and declaration moves.",
    slug: "gopls-interactive-refactoring",
    status: "published",
  },
  snapshot: {
    id: "snap_go_gopls_interactive_refactoring",
    sourceHash: "fixture-go-gopls-interactive-refactoring-v1",
    fetchedAt: "2026-10-20T18:05:00.000Z",
    finalUrl: goplsUrl,
    httpStatus: 200,
    wordCount: 1539,
    blocks: [
      block(
        "b1",
        "quote",
        "the LSP's lack of a mechanism for language servers to ask the user for input.",
        goplsUrl,
        ["Add struct tags, without questions"],
      ),
      block(
        "b2",
        "quote",
        "language servers can now easily provide new operations with one or more parameters.",
        goplsUrl,
        ["Add struct tags, without questions"],
      ),
      block(
        "b3",
        "quote",
        "Gopls moves the declaration along with its dependent declarations (such as unexported helpers or methods) while leaving unrelated symbols in place, updates references across your workspace, and cleans up imports in both the source and destination files.",
        goplsUrl,
        ["Moving declarations across files and packages (preview)"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "Teaching the editor to ask before it refactors",
    dek:
      "LSP code actions used to be parameterless. gopls now uses a proposed interactive refactoring capability to ask for tag names, naming conventions, interfaces, and destinations.",
    oneSentence:
      "Interactive refactoring lets a language server collect user input before it computes edits, so gopls can offer transformations that need more than the cursor position.",
    tldr: [
      "Most LSP code actions behave like functions with no parameters. The server has to infer the user's intent from the cursor and syntax tree, or decline to offer the action.",
      "The proposed interactive refactoring capability lets a language server ask the client for input in one or more steps, then return the edits.",
      "gopls uses it for adding or removing struct tags, implementing an interface, and moving a declaration across files or packages.",
      "The capability is editor-agnostic. Working support is in gopls v0.24.0 and the VS Code Go extension v0.56.0, with proof-of-concept integrations for Neovim and Emacs.",
    ],
    sections: [
      {
        id: "zero-parameter",
        title: "The zero-parameter code action",
        blocks: [
          p(
            r(
              "The Language Server Protocol decouples language features from editors. The editor and a language server exchange JSON-RPC messages for autocomplete, hover, diagnostics, and code actions. The editor does not need to know how Go resolves an interface; gopls does.",
              "s1",
            ),
          ),
          p(
            r(
              "Almost every code transformation in the protocol works like a function with no parameters. The user triggers it, and the server immediately computes the edits from the cursor position and the enclosing syntax tree. Renaming a symbol is the exception: it needs the new name, so the protocol gave it a dedicated ",
              "s1",
            ),
            r("PrepareRename", undefined, { code: true }),
            r(" request.", "s1"),
          ),
          p(
            r(
              "That model works when the context is enough. It breaks when the user needs to choose a tag set, a naming convention, an interface, or a destination file. The server can apply a one-size-fits-all default, or it can refrain from offering the transformation. The protocol has no way to ask for input, even though gopls can compute the edits.",
              "s1",
            ),
          ),
          p(
            r(
              "Before interactive refactoring, ",
              "s1",
            ),
            r("Add struct tags", undefined, { code: true }),
            r(
              " always produced JSON tags in camelCase. That is a reasonable default, and a bad answer for a Go service that serializes to YAML, writes to a database, or uses snake_case.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "what-it-adds",
        title: "What the proposal adds",
        blocks: [
          p(
            r(
              "The proposal, developed with the Dart team, establishes a standard mechanism for a language server to collect user input before computing text edits. A server can ask for one value or several, and it can do so in multiple steps. The client renders the questions using its own UI.",
              "s1",
            ),
          ),
          p(
            r(
              "The design is deliberately not Go-specific. LSP's purpose is to let one server improvement reach every editor that speaks the protocol. An editor-specific dialog would work in VS Code, the editor with the most Go users, and leave Neovim and Emacs behind.",
              "s1",
            ),
          ),
          p(
            r(
              "Working support is available in gopls v0.24.0 and the official Go extension for VS Code v0.56.0. The Go team also explored proof-of-concept client integrations for Neovim and Emacs. The protocol proposal is still a proposal, not a finished standard.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "tags-and-interfaces",
        title: "Tags, interfaces, and real edits",
        blocks: [
          p(
            r(
              "The struct-tag action shows the shape of the change. Place the cursor on a struct and choose ",
              "s1",
            ),
            r("Add struct tags", undefined, { code: true }),
            r(
              ". A dialog appears, pre-filled with ",
              "s1",
            ),
            r("json", undefined, { code: true }),
            r(
              ". The user can add ",
              "s1",
            ),
            r("yaml", undefined, { code: true }),
            r(" or ", "s1"),
            r("db", undefined, { code: true }),
            r(
              ", then choose camelCase, snake_case, or PascalCase in a second dialog. Gopls generates the formatted tags and applies them across the type definition.",
              "s1",
            ),
          ),
          p(
            r(
              "The inverse action now asks which tag keys to remove. Removing only the ",
              "s1",
            ),
            r("db", undefined, { code: true }),
            r(
              " tags while keeping JSON is a normal request. The old action wiped out every tag, which made it useful mostly for structs that had only one kind.",
              "s1",
            ),
          ),
          p(
            r(
              "The interface action is more ambitious. Place the cursor on a concrete type and choose ",
              "s1",
            ),
            r("Add methods to X to implement an interface…", undefined, { code: true }),
            r(
              ". A text field accepts an interface name and uses dynamic queries to autocomplete types from the workspace and the standard library, such as ",
              "s1",
            ),
            r("maphash.Hasher", undefined, { code: true }),
            r(
              ". If the interface has type parameters, gopls asks for a concrete type argument for each parameter, then generates method stubs with receiver names and instantiated signatures. The stubs panic with ",
              "s1",
            ),
            r('panic("unimplemented")', undefined, { code: true }),
            r(" until the developer fills them in.", "s1"),
          ),
        ],
      },
      {
        id: "move-declarations",
        title: "Moving declarations across files",
        blocks: [
          p(
            r(
              "Moving a declaration by cutting and pasting is easy to get wrong. References break, imports are left behind, and a helper that was only used by the moved type stays in the old file. The interactive version is still a preview, but the working implementation shows the intended behavior.",
              "s1",
            ),
          ),
          p(
            r(
              "Place the cursor on a top-level declaration and choose ",
              "s1",
            ),
            r("Move declaration X", undefined, { code: true }),
            r(
              ". A file picker lets the user choose an existing ",
              "s1",
            ),
            r(".go", undefined, { code: true }),
            r(
              " file or specify a new path. gopls moves the declaration, its dependent declarations, and its methods, updates references across the workspace, and cleans up imports in both files.",
              "s1",
            ),
          ),
          p(
            r(
              "In the example, a type ",
              "s1",
            ),
            r("Foo", undefined, { code: true }),
            r(" moves from package ", "s1"),
            r("from", undefined, { code: true }),
            r(" to package ", "s1"),
            r("to", undefined, { code: true }),
            r(
              ". Its method ",
              "s1",
            ),
            r("Print", undefined, { code: true }),
            r(" and the unexported constant ", "s1"),
            r("bar", undefined, { code: true }),
            r(
              " move with it because only Foo uses them. The unrelated function ",
              "s1",
            ),
            r("Baz", undefined, { code: true }),
            r(" stays behind.", "s1"),
          ),
        ],
      },
      {
        id: "why-protocol",
        title: "Why this belongs in the protocol",
        blocks: [
          p(
            r(
              "Better Go refactorings are the immediate benefit. Putting the interaction in the server means every client that implements the capability can use it, instead of only the editor whose extension shipped it first.",
              "s1",
            ),
          ),
          p(
            r(
              "The proposal also opens the door to operations that need user configuration but do not produce a text edit. The Go team lists change-signature refactoring, interactive conflict resolution for naming collisions or shadowing, and configuring test or benchmark runs with profiling flags.",
              "s1",
            ),
          ),
          p(
            r(
              "The change is larger than a new menu item: the server can negotiate with the user before it acts, so the refactoring can proceed with the choices it needs.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "what-to-watch",
        title: "What to watch",
        blocks: [
          p(
            r(
              "Interactive refactoring is available now, but the protocol proposal is not final. Client support varies, and the exact UI is up to the editor. A feature that works in VS Code may not be exposed in another client until that client implements the capability.",
              "s1",
            ),
          ),
          p(
            r(
              "The generated code still needs review. Interface stubs panic by default. Moving a declaration can change package boundaries and import cycles. The server computed the edit; a person still has to judge whether it is safe.",
              "s1",
            ),
          ),
          p(
            r(
              "Try a refactoring you would otherwise do by hand, then inspect the diff. The feature is strongest when it removes a tedious, error-prone step. It is weakest when it hides a decision that deserves a deliberate look.",
            ),
          ),
        ],
      },
    ],
    diagram: {
      kind: "sequence",
      title: "A refactoring that asks before it edits",
      description:
        "The editor sends a code action request. gopls asks the user for the missing choices, receives them through the client, and returns a workspace edit.",
      conceptual: true,
      nodes: [
        { id: "user", label: "User", detail: "chooses the refactoring", cite: "s1" },
        { id: "editor", label: "Editor", detail: "renders the dialogs", cite: "s1" },
        { id: "gopls", label: "gopls", detail: "computes the edit", cite: "s1" },
        { id: "workspace", label: "Workspace", detail: "files and references", cite: "s1" },
      ],
      edges: [
        { from: "user", to: "editor", label: "trigger action" },
        { from: "editor", to: "gopls", label: "code action" },
        { from: "gopls", to: "editor", label: "ask for tags" },
        { from: "editor", to: "user", label: "dialog" },
        { from: "user", to: "editor", label: "json, db" },
        { from: "editor", to: "gopls", label: "selection" },
        { from: "gopls", to: "workspace", label: "workspace edit" },
        { from: "workspace", to: "editor", label: "apply" },
      ],
      caption:
        "The server still computes the edit. The new part is the bounded conversation before it does, so the user can supply what the syntax tree cannot.",
    },
    eli5: {
      body: [
        p(
          r(
            "A code action used to be a vending machine with one button. You press Add struct tags and the machine decides JSON camelCase for you. Interactive refactoring gives the machine a small screen and a keypad, so it can ask which tags and which casing before it writes anything.",
          ),
        ),
        p(
          r(
            "The machine still does the work. It just stops guessing when the answer depends on what you want.",
          ),
        ),
      ],
      limit:
        "The screen only helps if the editor implements it. The server still computes the edits, and you still need to review the diff.",
    },
    tradeoffs: [
      {
        title: "More questions, more control",
        body:
          "A dialog can interrupt flow, especially for a refactoring you do often. It is most useful when the choice is ambiguous or destructive, and least useful when a good default is obvious.",
      },
      {
        title: "Protocol work versus editor-specific hacks",
        body:
          "A standard capability reaches every editor that implements it, but it takes longer to design and ship. An editor-specific dialog ships faster and leaves other clients behind.",
      },
      {
        title: "Generated code still needs review",
        body:
          "Interface stubs panic until implemented, and moving declarations can change package boundaries. The server removes mechanical work; it does not remove the need to inspect the result.",
      },
    ],
    whenUseful: [
      "You write Go in VS Code, Neovim, Emacs, or another editor with an LSP client.",
      "You maintain a language server or editor extension and need a way to collect input for a code action.",
      "You are designing refactoring tools that need more than the cursor position.",
      "You want to understand how a protocol change can improve several editors at once.",
    ],
    caveats: [
      "The LSP capability is a proposal, not a finalized standard. Behavior and client support may change.",
      "gopls v0.24.0 and VS Code Go v0.56.0 have working support. Other clients may lag or implement only part of the interaction.",
      "Move declaration is a preview. The generated edits still need review, especially across package boundaries.",
      "The article is written by the Go team and focuses on Go. The protocol design is broader, but the examples and implementation details are Go-specific.",
    ],
    sources: [
      {
        id: "s1",
        label: "The Go Blog: Interactive refactoring in gopls",
        url: goplsUrl,
        note: "Hongxiang Jiang, published October 16, 2026.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "Language Server Protocol 3.17 specification",
        url: "https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/",
        note: "The code action, command, and workspace edit messages referenced by the proposal.",
      },
      {
        id: "s3",
        label: "gopls v0.24.0 release notes",
        url: "https://go.dev/gopls/release/v0.24.0",
        note: "The gopls release that includes interactive refactoring.",
      },
      {
        id: "s4",
        label: "LSP interactive code actions design document",
        url: "https://go.googlesource.com/proposal/+/refs/heads/master/design/76331-lsp-interactive-refactoring.md",
        note: "The technical design, including the stateless form protocol and alternatives considered.",
      },
    ],
    readingMinutes: 5,
    topic: "developer-tools",
  },
};

const curlUrl =
  "https://daniel.haxx.se/blog/2026/10/20/do-minor-curl-vulnerabilities-in-the-open/";

const curl: FixtureArticle = {
  source: {
    id: "daniel-stenberg",
    name: "Daniel Stenberg",
    siteUrl: "https://daniel.haxx.se/blog/",
    host: "daniel.haxx.se",
    feedUrl: "https://daniel.haxx.se/blog/feed/",
  },
  topic: security,
  article: {
    id: "art_curl_vulnerability_disclosure",
    canonicalUrl: curlUrl,
    originalTitle: "Do minor curl vulnerabilities in the open",
    publishedAt: "2026-10-20T08:09:42.000Z",
    discoveredAt: "2026-10-20T18:00:00.000Z",
    author: "Daniel Stenberg",
    summary:
      "curl is moving LOW and MEDIUM vulnerability reports to public GitHub issues on October 26, 2026. HIGH and CRITICAL reports stay private in HackerOne.",
    slug: "curl-vulnerability-disclosure-public",
    status: "published",
  },
  snapshot: {
    id: "snap_curl_vulnerability_disclosure",
    sourceHash: "fixture-curl-vulnerability-disclosure-v1",
    fetchedAt: "2026-10-20T18:05:00.000Z",
    finalUrl: curlUrl,
    httpStatus: 200,
    wordCount: 971,
    blocks: [
      block(
        "b1",
        "quote",
        "starting October 26 2026, we insist that all vulnerability reports submitted to us that are deemed to be severity LOW or MEDIUM should instead be submitted as issues in our GitHub repository.",
        curlUrl,
        ["Do minor curl vulnerabilities in the open"],
      ),
      block(
        "b2",
        "quote",
        "Over the last few years, over 90% of all submissions could quickly be assessed to be less than HIGH.",
        curlUrl,
        ["Do minor curl vulnerabilities in the open"],
      ),
      block(
        "b3",
        "quote",
        "We limit this practice to less than HIGH for this reason: at least these problems are not terrible.",
        curlUrl,
        ["The risks"],
      ),
    ],
  },
  explanation: {
    schemaVersion: "1",
    contextHeadline: "When the security queue outgrows the security team",
    dek:
      "curl will send LOW and MEDIUM vulnerability reports to public GitHub issues starting October 26, 2026. HIGH and CRITICAL reports stay private.",
    oneSentence:
      "curl is moving low- and medium-severity reports into public GitHub issues to share triage work and keep its small maintainer team from drowning in private reports.",
    tldr: [
      "Starting October 26, 2026, LOW and MEDIUM vulnerability reports should go to curl's GitHub issues. HIGH and CRITICAL reports stay in HackerOne.",
      "More than 90% of recent submissions were assessed below HIGH, and the project says the volume keeps rising.",
      "Public triage can share the work of assessing a report, writing an advisory, and checking a fix for related problems. Distributions and users can also follow fixes earlier.",
      "The trade-off is a longer public window for lower-severity issues. curl accepts that risk to keep the project sustainable.",
    ],
    sections: [
      {
        id: "policy-change",
        title: "The policy change",
        blocks: [
          p(
            r(
              "The curl project is changing its vulnerability disclosure procedure. Starting October 26, 2026, reports that the project deems LOW or MEDIUM should be submitted as issues in the curl GitHub repository. Only HIGH and CRITICAL reports stay private in the HackerOne tracker.",
              "s1",
            ),
          ),
          p(
            r(
              "Researchers who are unsure about severity can still submit through HackerOne and ask the project to assess it. Reports that turn out to be LOW or MEDIUM will be asked to move to GitHub and will be closed as informative on HackerOne, which also makes them public.",
              "s1",
            ),
          ),
          p(
            r(
              "The project uses four severity levels: LOW, MEDIUM, HIGH, and CRITICAL. It refers back to recent vulnerabilities and publishes guidelines to make the judgment less arbitrary. The policy still depends on that judgment being consistent.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "why-now",
        title: "Why now",
        blocks: [
          p(
            r(
              "Stenberg is direct about the cause. The project is seeing an avalanche of vulnerability reports, and the key maintainers feel strained, overloaded, and at the edge of what they can handle. He does not expect the flood to decrease in the next several months.",
              "s1",
            ),
          ),
          p(
            r(
              "More than 90% of the submissions in recent years could be quickly assessed as less than HIGH. Many come from AI-assisted researchers trying unusual option combinations and protocol mixes. Some describe behavior that would be obvious to any application using that combination, or that has almost no chance of occurring in the real world.",
              "s1",
            ),
          ),
          p(
            r(
              "The project cannot simply ignore LOW reports. Within the CVE program there is an appeals process, and if curl does not assign a CVE to an actual vulnerability, someone else can. True vulnerabilities would come back anyway. What curl can do is push back harder on reports that do not hurt users or existing applications.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "public-benefits",
        title: "What public triage buys",
        blocks: [
          p(
            r(
              "Opening the process lets more people participate. They can help assess the report, understand the claimed vulnerability, write the advisory, and work out when the issue was introduced. Stenberg argues this can produce a better fix and a better check for related problems sitting next to it.",
              "s1",
            ),
          ),
          p(
            r(
              "He also points to a recent pattern: after curl announces a set of CVEs and fixes, AI-using researchers throw those fixes at their models to find similar mistakes or omissions. A public process gives more people a chance to do that scrutiny before the next release.",
              "s1",
            ),
          ),
          p(
            r(
              "The work per report does not shrink. The hope is that the burden is easier to share and that the discussions produce lessons and documentation that are easier to find. Distributions and other curl users can also keep up with security fixes earlier.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "the-risk",
        title: "The risk curl is accepting",
        blocks: [
          p(
            r(
              "Handling a vulnerability in public makes it available to everyone, including people who want to exploit it. Stenberg says this gives attackers a slightly longer window at the expense of existing curl users. The project limits the practice to issues below HIGH for that reason.",
              "s1",
            ),
          ),
          p(
            r(
              "He considers the opposite mistake, a researcher filing a HIGH issue publicly as if it were LOW or MEDIUM, unlikely. Researchers rarely understate severity. Public vulnerability reports already happened before this policy, so the risk is not entirely new.",
              "s1",
            ),
          ),
          p(
            r(
              "The policy is a bet that the lower-severity queue can be made more sustainable without creating a serious new exposure. Public disclosure still has a cost.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "what-is-a-vulnerability",
        title: "What counts as a vulnerability",
        blocks: [
          p(
            r(
              "The policy change is also an argument about what counts as a vulnerability. libcurl has a large option surface, many protocols, and a flexible API. An AI model can generate combinations that produce unexpected behavior. That does not automatically make the combination a security problem.",
              "s1",
            ),
          ),
          p(
            r(
              "Stenberg says the project does not have the bandwidth, manpower, or will to handle a never-ending stream at the current pace. He wants to decline reports that do not hurt users, while still handling true vulnerabilities through the CVE process.",
              "s1",
            ),
          ),
          p(
            r(
              "Maintainership carries an uncomfortable trade. A project can be criticized for being slow to respond, and also for spending too much time on reports that do not matter. The new policy is an attempt to move the low-severity discussion into a place where more people can help and the private queue stays reserved for the reports that need it.",
              "s1",
            ),
          ),
        ],
      },
      {
        id: "what-to-do",
        title: "What reporters and users should do",
        blocks: [
          p(
            r(
              "If you believe you have a HIGH or CRITICAL issue in curl or libcurl, use the private HackerOne tracker. If you believe it is LOW or MEDIUM, open a GitHub issue with the curl version, the affected options or protocol, a minimal reproducer, and the impact you can demonstrate. If you are unsure, submit privately and ask for a severity assessment.",
              "s1",
            ),
          ),
          p(
            r(
              "Users should keep patching. A public low-severity issue is still a bug, and a chain of low-severity bugs can matter in the right environment. The policy changes where the conversation happens, not whether the fix belongs in a release.",
              "s1",
            ),
          ),
          p(
            r(
              "For other maintainers, the transferable lesson is to define severity, publish the intake path, and plan for the week when the queue exceeds the team.",
            ),
          ),
        ],
      },
    ],
    diagram: {
      kind: "flow",
      title: "The new curl disclosure path",
      description:
        "Reports are triaged by severity. LOW and MEDIUM go to public GitHub issues; HIGH and CRITICAL stay private until a fix and advisory are ready.",
      conceptual: true,
      nodes: [
        { id: "report", label: "Report", detail: "researcher submits", cite: "s1" },
        { id: "triage", label: "Severity triage", detail: "LOW to CRITICAL", cite: "s1" },
        { id: "github", label: "GitHub issue", detail: "public, shared triage", cite: "s1" },
        { id: "hackerone", label: "HackerOne", detail: "private tracker", cite: "s1" },
        { id: "fix", label: "Fix and advisory", detail: "release work", cite: "s1" },
        { id: "public", label: "Public advisory", detail: "after the fix", cite: "s1" },
      ],
      edges: [
        { from: "report", to: "triage", label: "submit" },
        { from: "triage", to: "github", label: "LOW or MEDIUM" },
        { from: "triage", to: "hackerone", label: "HIGH or CRITICAL" },
        { from: "github", to: "fix", label: "public work" },
        { from: "hackerone", to: "fix", label: "private work" },
        { from: "fix", to: "public", label: "disclose" },
      ],
      caption:
        "The severity gate decides whether the work happens in public or in private. The fix still ships through the normal release and advisory process.",
    },
    eli5: {
      body: [
        p(
          r(
            "A small fire department gets hundreds of calls, and most are smoking toasters. It starts handling the toaster calls on a public forum so neighbors can help, while keeping real fires on the private emergency line.",
          ),
        ),
        p(
          r(
            "The public forum cannot put out a real fire. The policy only works if the dangerous calls still go to the private line and the severity judgment is honest.",
          ),
        ),
      ],
      limit:
        "A public issue is still visible to people who want to exploit it. curl limits the practice to issues below HIGH, but the window is real.",
    },
    tradeoffs: [
      {
        title: "Public triage versus the attacker window",
        body:
          "Public issues let more people help and let distributions follow fixes earlier. They also give attackers a longer look at lower-severity problems. curl accepts that trade only below HIGH.",
      },
      {
        title: "Maintainer sanity versus report completeness",
        body:
          "Moving low-severity reports to GitHub reduces the private queue and shares the work. It also means a report may be discussed by people who do not know the codebase, and the maintainers still have to make the final call.",
      },
      {
        title: "AI volume versus human judgment",
        body:
          "AI-assisted research can find real bugs and can also produce unlikely option combinations. The project needs severity guidelines and the confidence to decline reports that do not hurt users, without dismissing real vulnerabilities.",
      },
    ],
    whenUseful: [
      "You maintain an open-source project with a vulnerability disclosure process and a small team.",
      "You are a security researcher deciding whether a curl report belongs in HackerOne or GitHub.",
      "You want a concrete example of the trade-off between public triage and coordinated disclosure.",
      "You are designing severity guidelines for AI-assisted vulnerability reports.",
    ],
    caveats: [
      "The policy starts October 26, 2026. This explainer describes the announcement, not the results of the change.",
      "Severity judgments are contested. A report that curl calls LOW may matter more in a specific application or deployment.",
      "The article is written by curl's lead maintainer and presents the project's rationale. It is not an independent evaluation of the policy.",
      "Public disclosure of a low-severity issue can still create risk, especially when several issues are chained together.",
    ],
    sources: [
      {
        id: "s1",
        label: "Daniel Stenberg: Do minor curl vulnerabilities in the open",
        url: curlUrl,
        note: "Published October 20, 2026.",
        evidenceIds: ["b1", "b2", "b3"],
      },
      {
        id: "s2",
        label: "curl vulnerability disclosure policy",
        url: "https://curl.se/dev/vuln-disclosure.html",
        note: "The project's formal disclosure process and severity guidance.",
      },
      {
        id: "s3",
        label: "curl security page",
        url: "https://curl.se/docs/security.html",
        note: "Security advisories, CVE records, and the project's security process.",
      },
    ],
    readingMinutes: 4,
    topic: "security",
  },
};

export const NEW_FIXTURES: FixtureArticle[] = [d1, goHttp1, etcd, minerva, gopls, curl];
