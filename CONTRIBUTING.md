# Contributing

Thanks for taking a look. Understory is a small project, so a clear issue or a
focused pull request is more useful than a large speculative change.

## Before you start

- Open an issue for a new feature, a schema change, or a substantial editorial
  change. It is easier to agree on the problem before the diff exists.
- Security problems should follow [SECURITY.md](SECURITY.md), not a public issue.
- By contributing, you agree that code contributions are licensed under the MIT
  License and original editorial contributions are licensed under CC BY 4.0.
  You keep the copyright to your work.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:setup
npm run dev
```

The web app runs at `http://localhost:8790`. The pipeline worker runs at
`http://localhost:8791` with `npm run dev:pipeline`. Workers AI is not available
in local Wrangler; use the seeded fixtures for UI work.

## Checks

Run these before opening a pull request:

```bash
npm run check
```

That runs TypeScript and the Vitest suite. If you change a page layout, also do
a visual pass at desktop and phone widths. If you change the schema, add a
migration and update the seeds or tests that depend on it.

## Code style

- Keep the existing TypeScript, Hono, and JSX patterns.
- Prefer small functions with explicit types at module boundaries.
- Keep server-rendered output accessible and usable without JavaScript.
- Do not add a dependency for something the standard library or an existing
  dependency already does well.
- Do not put secrets, tokens, account IDs, or database IDs in source files.
  Use `.dev.vars` locally and Wrangler secrets in deployment.

## Editorial contributions

An explainer is not a summary of a press release. It should explain a mechanism,
name the trade-offs, and show where the evidence stops.

Every published explainer needs:

- a link to the original article and a clear attribution line;
- context, a one-sentence explanation, and a TL;DR;
- at least two sections that explain how the system works;
- a diagram that matches the explanation;
- an ELI5 and its limit;
- trade-offs, when the idea is useful, and caveats;
- source references that resolve to real URLs.

Follow these rules:

1. **Link the original.** The publisher link belongs in the article header, the
   sheet record, and the source list.
2. **Quote briefly.** Source snapshots may contain a few short quotations for
   identification and review. Do not paste full sections, full articles, or long
   excerpts into fixtures, tests, or issues.
3. **Attribute claims.** Numbers, quotes, and findings belong to the linked
   source. Background that is not in the source should be marked as background.
4. **Do not invent.** No fabricated benchmarks, quotes, customers, or
   implementation details. If the source does not say it, leave it out or label
   the uncertainty.
5. **Review before publishing.** A generated draft is not a fact-check. A person
   must read it against the source and approve it.
6. **Respect the license.** Publisher articles are not covered by this
   repository's CC BY 4.0 license. See [CONTENT-LICENSE.md](CONTENT-LICENSE.md)
   and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Pull requests

- Keep the change focused and explain what changed and why.
- Include the checks you ran.
- If the change affects published content, say which explainers changed and
  whether the source snapshots were rechecked.
- Do not include generated build output, local agent tooling, or `.dev.vars`.
