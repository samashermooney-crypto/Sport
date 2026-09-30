# Phase 14 public-site Lighthouse results

Captured September 28, 2026 at 20:22 CDT with Lighthouse 13.5.0 against a
published synthetic organization containing a home page, public program, and
upcoming event. The route was served by `createSiteSsrRouter` directly. The
website `publicRouter` is now registered on `track/integration` and mounted by
`createApp`; its integration test covers platform subdomains, verified custom
domains, and host-root sitemap/robots routes. These reports are historical
direct-router results and must be repeated against the shared-app mount before
Phase 14 Lighthouse sign-off.

Lighthouse used its mobile preset (412×823, 1.75 device scale, simulated 4×
CPU slowdown and 150 ms RTT). The bundled headless Chromium was 153.0.8010.12.
The complete raw JSON reports are checked in beside this file.

| Route             | Performance | Accessibility | SEO | Result |
| ----------------- | ----------: | ------------: | --: | ------ |
| Organization home |          98 |           100 | 100 | Pass   |
| Programs          |          99 |           100 | 100 | Pass   |
| Schedule          |          99 |           100 | 100 | Pass   |

Targets are Performance ≥ 90, Accessibility 100, and SEO ≥ 95. The first audit
run exposed a 0.239 CLS from late font loading. The current reports are after
preconnecting and preloading the existing Open Sans Latin subsets; no font or
design token was changed.
