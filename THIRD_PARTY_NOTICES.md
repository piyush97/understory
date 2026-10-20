# Third-party notices

Understory is an independent reading project. It is not affiliated with or
endorsed by any of the publishers listed here.

The code in this repository is licensed under the MIT License. Original
editorial prose and diagrams are licensed under CC BY 4.0. Those licenses do
not apply to the third-party material below.

## Publisher articles

Understory discovers posts through [engineeringblogs.xyz](https://engineeringblogs.xyz/),
then links to the original article and stores a small number of short quotations
for editorial review. The articles, their text, and their images remain the
property of their authors and publishers. The quotations are not a substitute
for the original, and this repository does not grant permission to reproduce a
full article.

The published explainers in the seed currently reference these articles:

| Publisher | Article | Date | Author |
| --- | --- | --- | --- |
| Cloudflare | [Cutting our inference bill by 68% by being obsessive about optimization](https://blog.cloudflare.com/obsessive-inference-optimization/) | 2026-10-19 | Ryan Skidmore |
| Tailscale | [MagicRoute: Routing without physical routers](https://tailscale.com/blog/magicroute-beta) | 2026-10-19 | Tailscale |
| GitHub | [From 2,500 requests to 24: Rebuilding star history without the stargazers](https://github.blog/engineering/architecture-optimization/from-2500-requests-to-24-rebuilding-star-history-without-the-stargazers/) | 2026-10-14 | GitHub Engineering |
| Daniel Lemire | [Decoding base64 in Python at 10 gigabytes per second](https://lemire.me/blog/2026/10/17/decoding-base64-in-python-at-10-gigabytes-per-second/) | 2026-10-17 | Daniel Lemire |
| Cloudflare | [Under the hood, off the hot path: how D1 scales to millions of databases](https://blog.cloudflare.com/d1-control-plane/) | 2026-10-13 | David Laban and Lambros Petrou |
| The Go Blog | [Better HTTP/1 connection reuse](https://go.dev/blog/http-connection-reuse) | 2026-10-14 | Nicholas Husin and Damien Neil |
| Red Hat Developers | [Sharding etcd on hosted control planes and what the numbers actually say](https://developers.redhat.com/articles/2026/10/13/sharding-etcd-on-hosted-control-planes-and-what-the-numbers-actually-say) | 2026-10-13 | Vishnu Challa |
| eBay Engineering | [Inside Minerva: building scalable observability for eBay's monetization platform](https://innovation.ebayinc.com/stories/inside-minerva-building-scalable-observability-for-ebays-monetization-platform/) | 2026-10-14 | Gautam Singh, Ravi Agarwal, and Akshay Kamath |
| The Go Blog | [Interactive refactoring in gopls](https://go.dev/blog/interactive-refactoring) | 2026-10-16 | Hongxiang Jiang |
| Daniel Stenberg | [Do minor curl vulnerabilities in the open](https://daniel.haxx.se/blog/2026/10/20/do-minor-curl-vulnerabilities-in-the-open/) | 2026-10-20 | Daniel Stenberg |

The discovery index itself is a public project run by Peter Cooper. Understory
uses the index to find posts and does not copy its listing content.

If you are a rights holder and believe a quotation or attribution is wrong,
open an issue with the URL and the specific passage. We will review it and
remove or correct the material when appropriate.

## Fonts

The app bundles three font families under the SIL Open Font License 1.1. The
license text for each family is included next to the font files.

| Family | Files | Copyright | License |
| --- | --- | --- | --- |
| Barlow Condensed | `public/assets/fonts/barlow-condensed-500.woff2`, `barlow-condensed-600.woff2` | Copyright 2017 The Barlow Project Authors | [OFL-Barlow-Condensed.txt](public/assets/fonts/OFL-Barlow-Condensed.txt) |
| Source Serif 4 | `public/assets/fonts/source-serif-4.woff2`, `source-serif-4-italic.woff2` | Copyright 2014 The Source Serif 4 Project Authors | [OFL-Source-Serif-4.txt](public/assets/fonts/OFL-Source-Serif-4.txt) |
| Spline Sans Mono | `public/assets/fonts/spline-sans-mono.woff2` | Copyright 2022 The Spline Sans Mono Project Authors | [OFL-Spline-Sans-Mono.txt](public/assets/fonts/OFL-Spline-Sans-Mono.txt) |

Upstream projects:

- [Barlow](https://github.com/jpt/barlow)
- [Source Serif](https://github.com/adobe-fonts/source-serif)
- [Spline Sans Mono](https://github.com/SorkinType/SplineSansMono)
- [SIL Open Font License 1.1](https://openfontlicense.org/)

## Dependencies and services

JavaScript dependencies are installed from npm and keep their own licenses. The
resolved versions and license identifiers are recorded in `package-lock.json`.
No dependency source is vendored in this repository.

Cloudflare Workers, D1, Queues, Workers AI, and the other Cloudflare services
are operated by Cloudflare under Cloudflare's terms. This repository contains
configuration and code that uses those services, not the services themselves.

## Trademarks

Cloudflare, D1, Workers, Go, gopls, Red Hat, OpenShift, eBay, curl, libcurl,
Tailscale, GitHub, and other product names are trademarks or registered
trademarks of their respective owners. Their use here is descriptive and does
not imply endorsement.
