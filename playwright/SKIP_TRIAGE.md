# Playwright `test.skip` triage

Phase 2 of the Playwright suite cleanup. Each `test.skip(...)` in `playwright/e2e/`
gets a 30-day clock: **owner fixes by 2026-06-25, or the test is deleted.** No
indefinite "keep but skip" status.

After Phase 1's bulk deletions, **15 `test.skip` calls remain** across 11 files.
One of them (`insight-navigation.spec.ts:19`) is inside a `forEach` that expands
to 7 distinct skipped tests at runtime, so the runtime skip count is ~21.

## How to use this doc

1. Find your team's row in the **Triage table** below.
2. Open a ticket per skip in your team's tracker. Title format:
   `[Playwright] Un-skip <file>:<line> — <one-line reason>`.
3. Add the ticket link to the test file as a `// Tracked: <url>` comment on the
   line directly above the `test.skip(`. Example:
   ```ts
   // Tracked: https://linear.posthog.com/issue/PROD-1234
   test.skip('Apply 1 overall filter', async ({ page }) => { ... })
   ```
4. The CI guard (see `scripts/check-skips.mjs`) will fail any PR that adds a
   `test.skip` without a `// Tracked: ...` comment within 3 lines above.
5. On 2026-06-25, sweep this directory: any remaining `test.skip` calls get
   deleted along with the test body.

## Skip categories

Categorising each skip helps decide whether un-skipping is worth the effort, or
whether the test should just be deleted.

- **(A) Stack/CI flake** — works locally, fails in CI. Most likely fixed by
  Phase 4's infra work (CPU contention, network reset, container readiness).
  Don't burn cycles fixing these as test-code problems first.
- **(B) Outdated UI** — feature shipped and the test no longer matches reality.
  Either update the selectors or delete; either way someone with product
  context decides.
- **(C) Temporary hack** — author skipped "just for now" to unblock something
  else. The "now" never ends. Default to delete unless an owner claims it.
- **(D) Feature missing coverage** — the test exists but the feature it
  exercises is incomplete. Usually pairs with an existing product backlog item.
- **(E) Unknown / no context** — bare `test.skip` with no comment. Delete by
  default; un-skip only if the author still remembers the intent.

## Triage table

| File:Line | Test name | Category | Skip comment in source | Suggested owner |
|---|---|---|---|---|
| `e2e/annotations.spec.ts:9` | Annotations loaded | **B / E** | (none — page-load smoke test) | Annotations / Product analytics |
| `e2e/toolbar.spec.ts:4` | Toolbar loads | **B / E** | (none — loads the toolbar against a demo URL) | Toolbar |
| `e2e/signup.spec.ts:90` | Can create user account with first name, last name and organization name | **E** | (none — bare skip, no comment) | Growth |
| `e2e/signup.spec.ts:219` | Shows redirect notice if redirecting for maintenance | **A** | `// TODO un-skip. // Skipping test as it was failing on master, see <internal Slack link>` (see security note below) | Growth |
| `e2e/events.spec.ts:60` | Apply 1 overall filter | **E** | (none — bare skip) | Product analytics |
| `e2e/events.spec.ts:70` | Separates feature flag properties into their own tab | **E** | (none — bare skip) | Product analytics / Feature flags |
| `e2e/surveys/crud.spec.ts:55` | creates, launches, edits and deletes new survey | **B** | `// NOTE: Currently skipping this because we changed to the new layout and this doesn't support the new layout yet.` | Surveys |
| `e2e/surveys/quickcreate.spec.ts:165` | survey responses visible in feature flag feedback tab | **D** | (none, but context suggests FF feedback tab integration is incomplete) | Surveys / Feature flags |
| `e2e/surveys/quickcreate.spec.ts:181` | list of surveys in ff feedback tab when multiple surveys exist | **D** | (none — same FF feedback tab area) | Surveys / Feature flags |
| `e2e/billing/billing-limits.spec.ts:49` | Show no limits set and allow user to set one | **E** | (none — bare skip) | Growth (billing) |
| `e2e/billing/billing-limits.spec.ts:130` | Show existing limit and allow user to remove it | **E** | (none — bare skip) | Growth (billing) |
| `e2e/product-analytics/cohorts.spec.ts:27` | Duplicate a cohort | **A** | `// works locally fails in CI` | Cohorts / Product analytics |
| `e2e/product-analytics/dashboards.spec.ts:118` | Can duplicate, rename, and remove dashboard tiles | **E** | (none — bare skip) | Dashboards / Product analytics |
| `e2e/product-analytics/insight-modals.spec.ts:9` | shows no matches message in persons modal | **A** | `// does not consistently load events 😡` | Product analytics |
| `e2e/product-analytics/insight-navigation.spec.ts:19` | can navigate to ${type} insight from saved insights page (×7 — Trends, Funnels, Retention, Paths, Stickiness, Lifecycle, SQL) | **C** | `// skipping things because we want to get a single passing test in` (test is inside a `forEach`) | Product analytics |

### Additional cleanup in the same file

- `e2e/product-analytics/insight-navigation.spec.ts:33` — a fully **commented-out** `test.skip('can navigate to insight by query', ...)` block. Delete in the same PR that handles the active skip on line 19. The body is incomplete (the comment above says *"commented out because the query spec is incorrect"*).
- `e2e/surveys/crud.spec.ts:107-110` — inside the line-55 skipped test, there's a known-flaky `await expect(page.getByTitle('t')).toBeVisible()` commented out with the note *"This is causing a test to flake. The screenshot shows the element in question, but we can't find it here."* When the surveys team un-skips the parent test, they need to resolve this assertion too — either fix the selector or delete the assertion.

## Category breakdown

| Category | Count | Notes |
|---|---|---|
| **A** — stack/CI flake | 3 | (`signup.spec.ts:219`, `cohorts.spec.ts:27`, `insight-modals.spec.ts:9`) — these will likely be fixed by Phase 4 infra work, not by test-code patches |
| **B** — outdated UI | 2 | (`annotations.spec.ts:9`, `surveys/crud.spec.ts:55`) — owners decide update vs delete |
| **C** — temporary hack | 1 (×7 expanded) | `insight-navigation.spec.ts:19` — strongly recommend deleting; "skipping to get a single passing test in" is not a sustainable bookmark |
| **D** — feature missing coverage | 2 | Both in `surveys/quickcreate.spec.ts` — FF feedback tab integration |
| **E** — unknown / bare skip | 7 | Default to delete unless owner claims them |

The (E) and (C) buckets together are 8 of 15 skips with no good reason to keep
them. Recommend deleting these at the start of Phase 2 rather than going
through the ticket dance.

## Security follow-up — internal Slack link in code

`e2e/signup.spec.ts:218` contains a comment with an internal Slack archive URL:

```
// TODO un-skip.
// Skipping test as it was failing on master, see https://posthog.slack.com/archives/C0113360FFV/p1749742204672659
```

This is a public open-source repo. Per `CLAUDE.md`'s public-repo guidance,
never reference private Slack threads from code that ships externally. The
ticketing step for this skip should also rewrite the comment to remove the
Slack URL — replace with the Linear ticket link only.

## CI enforcement

`playwright/scripts/check-skips.mjs` is a zero-dependency Node script that
scans `playwright/e2e/**/*.spec.ts` for `test.skip(` and `test.fixme(` and
fails if any of them lack a `// Tracked: <url>` comment within 3 lines above.

To enable in CI, add this step to `.github/workflows/ci-e2e-playwright.yml`
(or any workflow that always runs on PRs):

```yaml
- name: Check Playwright test.skip comments
  run: node playwright/scripts/check-skips.mjs
```

The script also runs locally via:

```sh
node playwright/scripts/check-skips.mjs
```

Until every existing skip has a `// Tracked: ...` comment, the guard runs in
**warn mode** (`CHECK_SKIPS_WARN_ONLY=1`) — it prints the list of offenders
but exits 0. After the first sweep, drop the env var to make it gating.
