# Security policy

## Supported versions

The `main` branch is the supported version. There are no long-lived release
branches yet.

## Reporting a vulnerability

Please do not open a public issue with exploit details, credentials, or a
working proof of concept.

Use GitHub's private vulnerability reporting for this repository if it is
enabled. If it is not available, open a minimal public issue asking the
maintainer to establish a private channel, without including the details.

Useful reports include:

- the affected route, worker, or command;
- the version, commit, or deployment where you saw the issue;
- the preconditions and the impact;
- a minimal reproduction, with secrets removed;
- any suggested fix, if you have one.

This is a small project with no bug bounty. Reports are handled on a best-effort
basis. Please give the maintainer a reasonable chance to fix the issue before
disclosing it publicly.

## Scope

In scope:

- the public web routes and the authenticated editorial routes;
- the discovery, extraction, generation, and queue pipeline;
- authentication and authorization around `/admin` and the pipeline endpoints;
- injection, SSRF, path handling, and unsafe HTML rendering;
- leaked secrets or accidental publication of local configuration.

Out of scope:

- vulnerabilities in Cloudflare's platform or Workers AI;
- vulnerabilities in third-party publisher sites that Understory links to;
- missing hardening headers with no demonstrated impact;
- reports that require a compromised Cloudflare account, a leaked
  `ADMIN_TOKEN`, or physical access to the machine running Wrangler.

## Secrets and local data

`.dev.vars`, `.env`, `.wrangler/`, and `.tmp/` are ignored by Git. Do not commit
Cloudflare API tokens, Access credentials, editorial tokens, or private logs.
Database/account IDs identify resources but do not authorize access; production
configuration contains such nonsecret identifiers. Forks must replace these
IDs and the custom-domain route. The example development token is not suitable
for a deployed site.

If you believe a secret was published, rotate it first, then report the
exposure. Removing the commit is not enough; the value must be treated as
compromised.

## Deployment boundaries

The editorial token is always required. With `REQUIRE_ACCESS_JWT="true"`,
configure `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` for a Cloudflare Access
application; the Worker verifies its signed assertion, not an email header.
Protect every ingress, including any enabled `workers.dev` hostname. The Worker
rejects admin POSTs whose `Origin` does not match `SITE_URL`, but it does not
throttle credential guesses: put a Cloudflare WAF rate-limit rule on
`/admin/login` (or disable token login and rely on Access) before exposing the
desk.

Publisher fetches reject nonpublic literal addresses and unsafe redirects,
with redirect, byte and time limits. Hostname checks do not resolve DNS and
cannot by themselves prevent DNS rebinding. The deployment must not expose
private network services to outbound publisher requests.
