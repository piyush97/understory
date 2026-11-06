import type { Context } from "hono";
import type { AppEnv, Bindings } from "../../shared/env";
import { Layout } from "../components/layout";
import { IconArrowRight, IconArrowUpRight } from "../components/icons";
import { loadSite } from "../lib/cache";
import { sha256Hex } from "../lib/api-auth";
import {
  allowSignup,
  createTrialOrg,
  findOrgForKeyHash,
  PAID_REQUEST_LIMIT,
  TRIAL_DAYS,
  TRIAL_REQUEST_LIMIT,
} from "../../infrastructure/billing";

const DOCS_URL = "https://github.com/piyush97/understory/blob/main/docs/api-v1.md";
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const SITEVERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
const TURNSTILE_ACTION = "trial";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormState = { email: string; name: string; error?: string };
type Issued = { key: string; orgId: string; email: string; trialEndsAt: string };

/** The developer pages load Turnstile and hand off to Lemon Squeezy checkout. */
function developerCsp(c: Context<AppEnv>): void {
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "font-src 'self'",
      `script-src 'self' ${TURNSTILE_ORIGIN}`,
      `frame-src ${TURNSTILE_ORIGIN}`,
      `connect-src 'self' ${TURNSTILE_ORIGIN}`,
      "base-uri 'none'",
      "form-action 'self' https://*.lemonsqueezy.com",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

/** Hosted checkout link carrying the org id back through the webhook, or null when billing is not configured. */
export function checkoutUrl(env: Bindings, orgId: string, email: string | null): string | null {
  if (!env.LEMONSQUEEZY_CHECKOUT_URL) return null;
  let url: URL;
  try {
    url = new URL(env.LEMONSQUEEZY_CHECKOUT_URL);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".lemonsqueezy.com")) return null;
  url.searchParams.set("checkout[custom][org_id]", orgId);
  if (email) url.searchParams.set("checkout[email]", email);
  return url.toString();
}

function sameOrigin(c: Context<AppEnv>): boolean {
  try {
    return c.req.header("origin") === new URL(c.env.SITE_URL).origin;
  } catch {
    return false;
  }
}

async function verifyTurnstile(env: Bindings, token: string, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || !token || token.length > 2048) return false;
  const allowed = (env.TURNSTILE_HOSTNAMES ?? new URL(env.SITE_URL).hostname)
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const result = (await res.json()) as { success?: boolean; action?: string; hostname?: string };
    return (
      result.success === true &&
      result.action === TURNSTILE_ACTION &&
      typeof result.hostname === "string" &&
      allowed.includes(result.hostname)
    );
  } catch {
    // Siteverify unreachable: fail closed.
    return false;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function DevelopersPage({
  c,
  form,
  issued,
  checkoutError,
}: {
  c: Context<AppEnv>;
  form?: FormState;
  issued?: Issued;
  checkoutError?: string;
}) {
  const siteKey = c.env.TURNSTILE_SITE_KEY;
  const billingOpen = Boolean(c.env.LEMONSQUEEZY_CHECKOUT_URL);
  const subscribeUrl = issued ? checkoutUrl(c.env, issued.orgId, issued.email) : null;
  const origin = c.env.SITE_URL.replace(/\/$/, "");
  return (
    <Layout
      title="API for developers"
      description="Free summary endpoints and a paid API with full Understory explainers, revisions, and a change feed."
      path="/developers"
      site={c.get("site")}
      siteUrl={c.env.SITE_URL}
      active="developers"
      noindex={Boolean(issued || form)}
    >
      {siteKey && !issued ? <script src={`${TURNSTILE_ORIGIN}/turnstile/v0/api.js`} async defer></script> : null}
      <div class="page page--about">
        <header class="page-head page-head--about">
          <h1>Understory API</h1>
          <p>
            Summaries are free and need no key. Full explainers, immutable revisions, and a change feed for
            syncing need an API key.
          </p>
        </header>

        <div class="about-main developers">
          {issued ? (
            <section class="about-section" id="key" aria-labelledby="key-title">
              <h2 id="key-title">Your trial key</h2>
              <p role="status">
                Copy this key now. Understory stores only a hash of it and cannot show it again.
              </p>
              <pre class="developers-key">
                <code>{issued.key}</code>
              </pre>
              <p>
                The trial allows {TRIAL_REQUEST_LIMIT.toLocaleString("en-US")} requests and ends{" "}
                {issued.trialEndsAt.slice(0, 10)}. Try it:
              </p>
              <pre class="developers-key">
                <code>{`curl -H "Authorization: Bearer ${issued.key}" ${origin}/api/v1/articles?limit=5`}</code>
              </pre>
              {subscribeUrl ? (
                <p>
                  <a class="button button--solid" href={subscribeUrl}>
                    Subscribe for $99 a month <IconArrowUpRight size={12} />
                  </a>
                </p>
              ) : null}
            </section>
          ) : null}

          <section class="about-section" id="plans" aria-labelledby="plans-title">
            <h2 id="plans-title">Free and paid access</h2>
            <dl class="developers-plans">
              <dt>Free, no key</dt>
              <dd>
                <code>GET /api/articles</code> and <code>GET /api/articles/:slug</code> return headlines, the
                one-sentence summary, the TL;DR, topic, source, and a link to the full explainer.
              </dd>
              <dt>Paid, $99 a month per organization</dt>
              <dd>
                <code>/api/v1</code> returns full explainers, diagrams, revisions, and a change feed.{" "}
                {PAID_REQUEST_LIMIT.toLocaleString("en-US")} requests a month, 60 a minute, no overage charges.
                Lemon Squeezy handles payment, tax, and invoices.
              </dd>
              <dt>Trial</dt>
              <dd>
                {TRIAL_DAYS} days and {TRIAL_REQUEST_LIMIT.toLocaleString("en-US")} requests on the paid API. No
                card required.
              </dd>
            </dl>
            <p>
              <a href={DOCS_URL} target="_blank" rel="noopener">
                Read the API reference <IconArrowUpRight size={11} />
              </a>
            </p>
          </section>

          {issued ? null : (
            <section class="about-section" id="trial" aria-labelledby="trial-title">
              <h2 id="trial-title">Start a trial</h2>
              {siteKey ? (
                <form class="login-form" method="post" action="/developers/trial">
                  {form?.error ? (
                    <p class="developers-error" role="alert">
                      {form.error}
                    </p>
                  ) : null}
                  <label for="trial-email">Work email</label>
                  <input
                    id="trial-email"
                    name="email"
                    type="email"
                    autocomplete="email"
                    maxlength={254}
                    required
                    value={form?.email ?? ""}
                  />
                  <label for="trial-name">Organization</label>
                  <input
                    id="trial-name"
                    name="name"
                    type="text"
                    autocomplete="organization"
                    maxlength={80}
                    required
                    value={form?.name ?? ""}
                  />
                  <div class="cf-turnstile" data-sitekey={siteKey} data-action={TURNSTILE_ACTION}></div>
                  <button class="button button--solid" type="submit">
                    Create my trial key <IconArrowRight size={14} />
                  </button>
                </form>
              ) : (
                <p>Trial signup is not open yet. Check back soon.</p>
              )}
            </section>
          )}

          <section class="about-section" id="subscribe" aria-labelledby="subscribe-title">
            <h2 id="subscribe-title">Subscribe with an existing key</h2>
            {billingOpen ? (
              <form class="login-form" method="post" action="/developers/checkout">
                {checkoutError ? (
                  <p class="developers-error" role="alert">
                    {checkoutError}
                  </p>
                ) : null}
                <label for="checkout-key">API key</label>
                <input id="checkout-key" name="key" type="password" autocomplete="off" required minlength={20} />
                <button class="button button--solid" type="submit">
                  Continue to checkout <IconArrowRight size={14} />
                </button>
              </form>
            ) : (
              <p>Paid plans are not open yet. Trial keys keep working until the trial ends.</p>
            )}
          </section>
        </div>
      </div>
    </Layout>
  );
}

export function renderDevelopers(c: Context<AppEnv>) {
  developerCsp(c);
  return c.render(<DevelopersPage c={c} />);
}

async function renderForm(c: Context<AppEnv>, status: 200 | 400 | 403 | 409 | 429 | 503, page: Parameters<typeof DevelopersPage>[0]) {
  await loadSite(c, true);
  developerCsp(c);
  c.header("Cache-Control", "no-store");
  c.status(status);
  return c.render(<DevelopersPage {...page} />);
}

export async function handleTrial(c: Context<AppEnv>) {
  if (!sameOrigin(c)) return c.text("Forbidden", 403);
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  const token = String(body["cf-turnstile-response"] ?? "");
  const form = (error: string): FormState => ({ email, name, error });

  if (!c.env.TURNSTILE_SITE_KEY || !c.env.TURNSTILE_SECRET) {
    return renderForm(c, 503, { c, form: form("Trial signup is not open yet.") });
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return renderForm(c, 400, { c, form: form("Enter a valid email address.") });
  }
  if (name.length < 1 || name.length > 80) {
    return renderForm(c, 400, { c, form: form("Enter an organization name of up to 80 characters.") });
  }
  const ip = c.req.header("cf-connecting-ip");
  if (!(await verifyTurnstile(c.env, token, ip))) {
    return renderForm(c, 403, { c, form: form("The human check did not pass. Try again.") });
  }
  const now = new Date();
  const ipHash = await sha256Hex(`signup:${ip ?? "unknown"}`);
  if (!(await allowSignup(c.env.DB, ipHash, now.toISOString().slice(0, 10)))) {
    return renderForm(c, 429, { c, form: form("Too many trials from this network today. Try again tomorrow.") });
  }

  const key = `us_test_${hex(crypto.getRandomValues(new Uint8Array(24)))}`;
  const orgId = `org_${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const created = await createTrialOrg(c.env.DB, {
    orgId,
    name,
    email,
    keyId: crypto.randomUUID(),
    keyPrefix: key.slice(0, 12),
    keyHash: await sha256Hex(key),
    now,
  });
  if (!created) {
    return renderForm(c, 409, {
      c,
      form: form("This email already has a trial. Use that key, or subscribe below."),
    });
  }
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString();
  return renderForm(c, 200, { c, issued: { key, orgId, email, trialEndsAt } });
}

export async function handleCheckout(c: Context<AppEnv>) {
  if (!sameOrigin(c)) return c.text("Forbidden", 403);
  const body = await c.req.parseBody();
  const key = String(body.key ?? "").trim();
  const org = key.length >= 20 && key.length <= 128 ? await findOrgForKeyHash(c.env.DB, await sha256Hex(key)) : null;
  if (!org) {
    return renderForm(c, 400, { c, checkoutError: "That key was not recognized." });
  }
  const url = checkoutUrl(c.env, org.id, org.email);
  if (!url) {
    return renderForm(c, 503, { c, checkoutError: "Paid plans are not open yet." });
  }
  c.header("Cache-Control", "no-store");
  return c.redirect(url, 303);
}
