# Phase 14 shared-app Lighthouse results

Captured 2026-09-30T09:50:31.532Z with Lighthouse 13.5.0 and Playwright Chromium.

GitHub Actions run: `36698501721` on integration commit `ff0828f49631d9edb868a2bdd9af3847ad07f479` (`ubuntu-24.04`).

Each route is served by the registered public website router in `createApp`; the local proxy serves the same `public/site.css` asset and forwards all page and SEO requests to the app.

| Route    | Performance | Accessibility | SEO |
| -------- | ----------: | ------------: | --: |
| home     |         100 |           100 | 100 |
| programs |         100 |           100 | 100 |
| schedule |         100 |           100 | 100 |

Targets: Performance ≥ 90, Accessibility 100, SEO ≥ 95.
