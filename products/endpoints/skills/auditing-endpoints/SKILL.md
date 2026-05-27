---
name: auditing-endpoints
description: >
  Audit every endpoint in a PostHog project for staleness, failed materialisations, and unused
  materialised versions. Use when the user asks "what endpoints can I clean up?", "are any of my
  endpoints broken?", "which materialised versions are still being called?", or wants a one-shot
  cleanup pass over the Endpoints product. Produces a prioritised report grouped by issue type, with
  recommended actions but does not modify anything without explicit confirmation.
---

# Auditing endpoints

This skill produces a project-wide audit of the Endpoints product. Use it when the user wants to
**find what to clean up** — unused endpoints, failing materialisations, materialised versions that
nobody calls any more. It does not modify anything; it reports.

The deeper investigation per endpoint is `diagnosing-endpoint-performance`. The audit's job is to
find candidates and hand off.

## When to use this skill

- "Audit my endpoints" / "What endpoints can I clean up?"
- The user is taking over a project and wants to know what they've inherited
- A periodic review (monthly / quarterly) of endpoint sprawl
- The user is over a materialisation cost budget and wants to know what to disable
- "Which versions am I actually using?" — only resolvable with the per-version usage signal

## Available tools

| Tool                                             | What it returns                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `endpoints-get-all`                              | Every endpoint with name, description, query, active status, current version, materialisation info |
| `endpoints-last-execution-times-create`          | Per-endpoint last execution time (over 6 months, personal API key calls)                           |
| `endpoints-versions-last-execution-times-create` | Per-(endpoint, version) last execution time — same scope                                           |
| `endpoint-materialization-status`                | Lightweight check per endpoint: is materialisation eligible, current status, last run, last error  |
| `endpoint-versions`                              | All versions for one endpoint, latest first                                                        |

## What counts as an issue

| Category                        | Trigger                                                                           | Typical action                                         |
| ------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Never called**                | Endpoint missing from `endpoints-last-execution-times-create` results             | Confirm with the user, then disable                    |
| **Stale**                       | `last_executed_at` more than 30 days old                                          | Confirm with the user; often safe to disable           |
| **Inactive**                    | `is_active: false` on the endpoint                                                | Verify intent; if abandoned, delete                    |
| **Failing materialisation**     | Materialisation status `Failed` with an error                                     | Hand off to `diagnosing-endpoint-performance`          |
| **Unused materialised version** | Materialised version absent from `endpoints-versions-last-execution-times-create` | Roll the endpoint to a newer version, or unmaterialise |
| **Drifted versions**            | Many versions exist but only the latest is called                                 | History noise — not an issue, but worth noting         |

Note these signals only cover **personal API key calls** in the last 6 months. Playground runs,
dashboard previews, and other non-API-key paths do not show up. An endpoint that looks "unused" by
this data may still be exercised internally — always confirm with the user before recommending
removal.

## Workflow

### 1. List all endpoints

Call `endpoints-get-all`. From the response, collect every `name` and note which ones are
materialised (`is_materialized: true` on the current version).

If the project is empty, tell the user and stop. Don't invent issues.

### 2. Pull endpoint-level usage

Call `endpoints-last-execution-times-create` with the full list of names. The response is a list
of `[name, last_executed_at]` rows. Endpoints missing from the response have not been called via
personal API key in the past 6 months.

Cross-reference with the endpoints list:

- **In list, not in usage** → never-called (or only called from non-API-key paths)
- **In usage, last_executed_at > 30 days ago** → stale
- **In usage, recent** → healthy

### 3. Pull per-version usage for materialised endpoints

For endpoints with `is_materialized: true`, call `endpoints-versions-last-execution-times-create`
with just those names. The response is `[name, version, last_executed_at]` rows.

For each materialised endpoint, compare its `versions` list to the per-version usage:

- Versions that **are materialised** but absent from the per-version usage → unused materialised
  versions, the prime cleanup target
- Versions present in usage older than 30 days → stale per-version

The per-version data only exists for queries logged after the `lc_endpoint_version` column was
added (~migration 0267). For projects where that migration only rolled out recently, expect
limited per-version history. Surface this caveat in the report when the version-level data is
sparse.

### 4. Check materialisation health

For each endpoint with `is_materialized: true`, call `endpoint-materialization-status`. Surface
any with `status: "Failed"` separately — these are active failures, not staleness.

### 5. Present the audit

Render a prioritised report grouped by category. Don't dump raw JSON; use a readable table per
section:

```text
## Endpoints audit — 9 issues

### 🔴 Failing materialisations (1)
- weekly_revenue (v3) — Failed 2h ago, "Column 'event_date' does not exist"
  → hand off to diagnosing-endpoint-performance

### 🟠 Never called via API key (3)
- internal_admin_query — created 5 months ago
- legacy_signup_funnel — created 1 year ago, materialised
- experiment_arm_lookup — created 9 months ago

### 🟠 Unused materialised versions (2)
- monthly_active_users — v3 materialised but no API calls in 6 months
  (currently on v4 — safe to unmaterialise v3)
- order_summary — v1 materialised but no API calls in 6 months

### 🟡 Stale (3)
- holiday_promo_2024 — last called 4 months ago
- ab_test_phase_1 — last called 2 months ago
- daily_revenue_cohort — last called 45 days ago

Recommended order:
1. Investigate the failing materialisation (blocks fresh data)
2. Unmaterialise the unused versions (free storage + compute)
3. Disable the never-called endpoints (if user confirms)
4. Review stale endpoints with the user
```

The exact format is less important than: prioritised, grouped, actionable, and hand-off
clear.

### 6. Offer the next step

End with a clear question, not a decision:

- "Want me to unmaterialise the two unused versions?" — needs `endpoint-update` with
  `is_materialized: false` per version
- "Want me to disable the never-called endpoints?" — needs `endpoint-update` with `is_active: false`
- "Want me to dig into the failing materialisation?" — hands off to
  `diagnosing-endpoint-performance`

**Never act from the audit alone.** Disabling or unmaterialising affects external API consumers;
always confirm before modifying.

## Example interaction

```text
User: "Audit my endpoints"

Agent steps:
- endpoints-get-all → 12 endpoints (4 materialised)
- endpoints-last-execution-times-create with all 12 names → 8 rows back
- endpoints-versions-last-execution-times-create with the 4 materialised names → 5 rows back
  (4 endpoints × 1-2 versions actually called)
- endpoint-materialization-status on each materialised endpoint → 1 failing

- Report:
  "Found 6 things worth looking at across 12 endpoints:

   🔴 Failing materialisations (1)
   - monthly_active_users (v2) — materialisation failed yesterday with
     'memory limit exceeded'. The endpoint is still callable inline but
     responses will be slower.

   🟠 Never called via API key in 6 months (3)
   - legacy_funnel_v1 — created 11 months ago
   - test_export — created 3 months ago
   - admin_dump — created 8 months ago, materialised (wasteful)

   🟠 Unused materialised versions (1)
   - order_summary v2 — materialised but only v3 is being called.
     The v2 materialised view can be dropped safely.

   🟡 Stale (1)
   - holiday_2024 — last called 5 months ago

   Caveat: usage data only covers personal-API-key calls. Playground
   and dashboard runs are not counted. Confirm before disabling.

   Want me to start with the failing materialisation, or clean up
   the unused versions first?"
```

## Important notes

- **The audit is read-only.** Never call destructive tools from this flow. Hand off or confirm
  before any modification.
- **Empty = healthy.** Don't pad an empty report with theoretical issues. "Nothing to clean up"
  is a good answer.
- **Per-version data has a horizon.** The `endpoint_version` tag is captured by the
  `lc_endpoint_version` column added in a ClickHouse migration. Queries logged before that
  migration rolled out will not surface per-version. Mention this in the report when relevant.
- **API-key-only scope.** The usage tools filter to personal API key requests. An endpoint
  exercised only from the playground or the app will look unused. Always confirm before acting.
- **Materialisation costs storage and compute.** When an unused materialised version is
  identified, the cheapest fix is `endpoint-update` with `is_materialized: false` targeted at
  that version — not deleting the endpoint.
- **Inactive ≠ stale.** An endpoint with `is_active: false` was deliberately turned off. Don't
  recommend deletion unless the user confirms it's truly abandoned.
