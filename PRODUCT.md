# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Cloudflare Workers, Hono with server-rendered JSX, D1, Queues, Workers AI, TypeScript. Confirmed constraint: Cloudflare free tier only. Chosen by the user and recorded in the approved architecture.

## Users

Software engineers, primarily staff and senior engineers, who scan engineering blogs for ideas worth their time. They read at a desk during a workday, often between tasks, and sometimes on a phone. They already know common engineering concepts; they do not know the context, mechanism, and trade-offs behind an unfamiliar post.

## Product Purpose

Understory turns the latest posts from engineeringblogs.xyz into validated explainers. Each explainer gives the reader a useful contextual headline, a TL;DR, prerequisite background, a detailed explanation of how the work functions, a diagram, an ELI5 mental model, trade-offs, and sources. Success means a reader can explain the post's mechanism to a colleague without first reading three other articles.

## Positioning

A reading layer, not a summary bot. Every explanation is grounded in extracted source text, separates the author's findings from general background, includes a diagram rendered from validated structured data, and names its limits. The index is dense like Hacker News; the article is a teaching document.

## Operating Context

Articles are discovered from engineeringblogs.xyz. Original publishers and authors keep attribution and are linked prominently. Generation is asynchronous and precomputed; readers never wait on inference. New generations can publish automatically after validation. A private editorial surface remains available for existing drafts and manual-review mode. Automated checks are not human fact-checking. The public product is read-only in v1.

## Capabilities and Constraints

- Public feed, topic and publisher filters, article pages, citations, diagrams, and local bookmarks.
- No accounts, comments, voting, public submissions, or chat with articles in v1.
- No arbitrary URL ingestion and no unrestricted URL proxy.
- Runs on Cloudflare free tier: one web Worker, one pipeline Worker, D1, Queues, Workers AI, Cron Triggers.
- Daily generation is bounded and reserved. Exhausting the AI allowance pauses new generation; it must not break reading.
- With `AUTO_PUBLISH="true"`, only newly generated revisions that pass validation publish automatically. Existing drafts require human approval. Set it to `false` to require human review for all new drafts.
- Published revisions are immutable and independently addressable.
- Free-plan storage and queue retention govern retention policy.

## Brand Commitments

The product is named Understory. Voice: plain, technically precise, unhyped. Explain, do not sell. The name refers to the layer beneath the headline.

## Evidence on Hand

The initial build ships with a small set of fixture explainers derived from real, publicly listed engineering blog posts. Fixture prose is written for this project, not copied from publishers. Original titles, publishers, and canonical URLs are preserved. No customer quotes, benchmarks, or endorsements exist and none may be invented.

## Product Principles

1. Explain the mechanism, not just the announcement.
2. Ground every substantive claim, and show the evidence.
3. Dense index, generous article.
4. State the conditions and limits of a result.
5. Be honest about what the free tier can and cannot do.

## Accessibility & Inclusion

The reading experience must work without client JavaScript. Diagrams need text alternatives and a sensible reading order. Keyboard navigation, visible focus, and reduced-motion support are required.
