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
real Cloudflare API tokens, D1 database IDs, account IDs, or editorial tokens.
The example configuration uses placeholders and a local development token.

If you believe a secret was published, rotate it first, then report the
exposure. Removing the commit is not enough; the value must be treated as
compromised.
