import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import type { AppEnv, Bindings } from "../shared/env";
import { bool } from "../shared/env";
import { getSiteState } from "../infrastructure/db";
import { cachePage } from "./lib/cache";
import { renderFeed } from "./routes/feed";
import { renderArticle } from "./routes/article";
import { renderTopics } from "./routes/topics";
import { renderSources } from "./routes/sources";
import { renderAbout } from "./routes/about";
import { renderBookmarks } from "./routes/bookmarks";
import {
  handleApprove,
  handleDiscover,
  handleLogin,
  handleLogout,
  handleReject,
  renderAdmin,
  renderReview,
} from "./routes/admin";
import { renderApiArticle, renderApiArticles } from "./routes/api";
import { renderFeedXml, renderRobots, renderSitemap } from "./routes/meta";
import { renderError, renderNotFound } from "./routes/not-found";

const app = new Hono<AppEnv>();

// Before DB/rendering middleware: login, 404 and 500 responses must also be private.
app.use("*", async (c, next) => {
  const admin = c.req.path === "/admin" || c.req.path.startsWith("/admin/");
  if (admin) c.header("Cache-Control", "no-store");
  await next();
  if (admin) c.header("Cache-Control", "no-store");
});

app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({
      ok: true,
      service: "understory-web",
      environment: c.env.ENVIRONMENT,
      time: new Date().toISOString(),
    });
  } catch {
    return c.json({ ok: false, service: "understory-web", error: "database_unreachable" }, 503);
  }
});

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "font-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  if (c.env.ENVIRONMENT === "production") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  await next();
});

app.use("*", async (c, next) => {
  try {
    c.set("site", await getSiteState(c.env.DB));
  } catch {
    c.set("site", {
      published: 0,
      sources: 0,
      topics: 0,
      inReview: 0,
      publicationVersion: "0",
    });
  }
  await next();
});

app.use("*", jsxRenderer(undefined, { docType: true }));

app.use("/api/*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
});

app.options("/api/*", (c) => c.body(null, 204));

app.get("/", (c) => cachePage(c, 120, () => renderFeed(c)));
app.get("/articles/:slug", (c) => cachePage(c, 600, () => renderArticle(c)));
app.get("/topics", (c) => cachePage(c, 900, () => renderTopics(c)));
app.get("/sources", (c) => cachePage(c, 900, () => renderSources(c)));
app.get("/about", (c) => cachePage(c, 900, () => renderAbout(c)));
app.get("/bookmarks", (c) => cachePage(c, 900, () => renderBookmarks(c)));

app.get("/api/articles", (c) => cachePage(c, 60, () => renderApiArticles(c)));
app.get("/api/articles/:slug", (c) => cachePage(c, 300, () => renderApiArticle(c)));

app.get("/robots.txt", (c) => cachePage(c, 3600, () => renderRobots(c)));
app.get("/sitemap.xml", (c) => cachePage(c, 900, () => renderSitemap(c)));
app.get("/feed.xml", (c) => cachePage(c, 900, () => renderFeedXml(c)));

app.get("/admin", (c) => renderAdmin(c));
app.post("/admin/login", (c) => handleLogin(c));
app.post("/admin/logout", (c) => handleLogout(c));
app.post("/admin/discover", (c) => handleDiscover(c));
app.get("/admin/revisions/:id", (c) => renderReview(c));
app.post("/admin/revisions/:id/approve", (c) => handleApprove(c));
app.post("/admin/revisions/:id/reject", (c) => handleReject(c));

app.get("/assets/*", (c) => {
  if (!c.env.ASSETS) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

app.get("/favicon.ico", (c) => c.redirect("/assets/favicon.svg", 301));

app.onError((error, c) => {
  console.error(
    JSON.stringify({
      level: "error",
      service: "understory-web",
      path: c.req.path,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  return renderError(c);
});

app.notFound((c) => renderNotFound(c));

export { app };

export default {
  fetch(request: Request, env: Bindings, executionCtx: ExecutionContext) {
    return app.fetch(request, env, executionCtx);
  },
};
