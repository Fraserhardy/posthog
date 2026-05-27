---
name: creating-an-endpoint
description: >
  Create a PostHog endpoint with the right shape on the first try — covers query kind choice, name
  conventions, what to expose as variables (HogQL code_name vs insight breakdown), cache TTL, and
  whether to materialise on day one. Use when the user says "create an endpoint", "expose this
  query as an API", "turn this insight into an endpoint", or asks for help structuring a new
  endpoint. Steers away from common mistakes: materialising a query with breakdowns, inline-only
  variables on a materialised endpoint, unbounded date ranges, ambiguous names.
---

# Creating an endpoint

This skill walks through creating a new endpoint with the right configuration. Endpoints expose
saved HogQL or insight queries as callable HTTP routes — the configuration choices made at
creation time determine cost, latency, and how callers integrate.

The materialisation deep-dive lives at `references/materializing.md`. Pull it in when the
materialisation decision is non-obvious.

## When to use this skill

- "Create an endpoint for [query]"
- "Expose this insight as an API"
- "Help me turn this HogQL into a callable endpoint"
- A new caller (mobile app, customer-facing dashboard, downstream pipeline) needs PostHog data
  and the user is choosing how to deliver it

## Decisions to make in order

### 1. Should this even be an endpoint?

Endpoints are right when:

- An **external system** (someone else's code) needs to call PostHog for data
- The query is **stable** — not exploratory analysis
- The shape is **reusable** — same query with different parameters

Endpoints are wrong when:

- Internal dashboard or PostHog app needs the data — use an insight directly
- One-off analysis — use the SQL editor or a HogQL query directly
- Heavy aggregation that powers internal product features — usually data warehouse + saved
  query is a better fit

If the user is unsure, ask what's calling the endpoint and what shape they expect.

### 2. Pick a name

Names are URL-safe (letters, numbers, hyphens, underscores), start with a letter, max 128 chars,
must be unique within the project. Lean toward:

- **Descriptive over generic** — `weekly_active_users_by_org` over `metrics`
- **Snake_case** — matches how the name appears in code paths and URLs
- **No version in the name** — versions are managed by the endpoint itself
- **No "endpoint" in the name** — redundant

The name appears in the URL: `/api/environments/{team_id}/endpoints/{name}/run`. It's not
trivially renameable later (callers depend on the path) — get it right at creation.

### 3. Pick the query kind

Two options exist:

- **HogQL** (`HogQLQuery`) — raw SQL written by the user. Variables defined via `{variables.x}`
  syntax, matched on `code_name`. Recommended for new endpoints when the caller cares about
  the exact column shape of the response.
- **Insight** (`TrendsQuery`, `FunnelsQuery`, etc.) — wraps an existing insight definition.
  Breakdowns can act as variables. Useful when the user already has a polished insight and
  wants to expose it.

HogQL is the more flexible choice. Pick insight only when the user is genuinely re-publishing
an existing insight rather than building a new query.

### 4. Decide which inputs become variables

Anything that should change per-caller goes in variables; the rest is hard-coded in the query.

**For HogQL endpoints**, variables are declared in the query payload with `code_name`, `type`,
and `default`. Each call passes `{ "variables": { "<code_name>": value } }`.

Common patterns:

- Time windows: `date_from`, `date_to`, or a single `lookback_days` integer
- Identity filters: `user_id`, `account_id`, `team_id`
- Pagination control beyond `limit` / `offset` (these are first-class on the run endpoint already)

**For insight endpoints**, the breakdown property acts as the variable. Pass the breakdown
property name as the key. `date_from` / `date_to` work for non-materialised insight endpoints.

Avoid:

- **Variables that change the shape of the result** — keep the columns stable. If callers need
  fundamentally different result shapes, ship separate endpoints.
- **Variables that bypass safety** — don't expose a `where_clause` variable that lets callers
  inject arbitrary SQL.

### 5. Set the cache TTL (`data_freshness_seconds`)

The endpoint caches results for this many seconds before re-running the query. Default is 24h
(86400s).

| TTL          | When to pick it                                                      |
| ------------ | -------------------------------------------------------------------- |
| 60s–300s     | Real-time dashboards where staleness is visible                      |
| 900s–3600s   | Most cases — fresh enough for product usage, cheap for ClickHouse    |
| 3600s–86400s | Reports, weekly/daily metrics, anything aggregated over long periods |

Bias toward higher TTLs unless the user explicitly says the data must be fresher. A 1-hour TTL
on a query that runs in 200ms ClickHouse time saves ~3600x in some workloads.

### 6. Decide on day-one materialisation

See `references/materializing.md` for the full decision tree. Short version:

- **Recommend materialisation** when the endpoint will be called frequently, latency matters,
  and the user can tolerate staleness equal to the refresh interval (typically 5-15 minutes for
  scheduled materialisation, or hourly).
- **Skip materialisation** for low-traffic endpoints, exploratory new endpoints (you don't
  know yet if it'll get called), and queries where freshness is critical.

If unsure, create unmaterialised and add `is_materialized: true` later once usage stabilises.
That avoids paying for materialisation on a query nobody ends up calling.

## Workflow

1. Confirm the use case (step 1 above). If it's not actually a fit for an endpoint, recommend
   the alternative.
2. Agree a name with the user.
3. Walk through the query — confirm it's HogQL or insight, and that the columns/shape make sense.
4. Identify what should be a variable. Show the user the variable declaration syntax.
5. Pick TTL based on the user's freshness requirement (ask if not clear).
6. Make the materialisation call. If on the fence, ship without and revisit later.
7. Call `endpoint-create` with the agreed config.
8. Confirm by calling `endpoint-run` with a sample payload to verify the response shape.
9. Hand off to `consuming-endpoints-from-client-code` if the user is about to wire it up.

## Example interaction

```text
User: "I want to expose our monthly active users count as an API
       for our analytics partner"

Agent:
- "Quick check: is the partner going to call this on demand, or
   should we be pushing data to them? Endpoints are pull-only."
- User: "On demand"
- "Got it. A few choices:
   1. Name: how about monthly_active_users? Lowercase, descriptive,
      no version baggage.
   2. The query — is it HogQL or are you exposing an existing insight?
      HogQL gives you exact column control; insight reuses what you've
      already built.
   3. What should the partner be able to filter by? Org, time window,
      both?
   4. How fresh? If MAU drifts within a day is fine, we can cache
      results for 1-24 hours and serve almost everything from cache.
   5. Materialisation: if the partner is going to hit this many times
      per day, materialising it would make responses near-instant.
      The trade-off is ~10-15 minute staleness.

   What's your starting point on these?"

[user picks: HogQL, lookback_days + org_id variables, 3600s TTL,
 not materialised yet]

- endpoint-create monthly_active_users {query, variables, ...}
- endpoint-run with sample payload {org_id: "test", lookback_days: 30}
- "Created and tested. Want help wiring up the client code?
   That's consuming-endpoints-from-client-code."
```

## Important notes

- **The name lives in the URL.** Changing it later requires migrating callers. Pick well.
- **HogQL endpoints are more flexible than insight endpoints.** Default to HogQL unless the
  user has a specific reason to wrap an existing insight.
- **Variables with no default fail at call time.** Always set defaults during creation so the
  endpoint is testable from the playground without specifying every variable.
- **Materialised endpoints require all variables to be passed.** Calls without them are
  rejected — this is intentional (security: prevents returning unfiltered data). Pair the
  materialisation recommendation with a note to the user about which variables become required.
- **Don't enable materialisation on a query that isn't eligible.** Use
  `endpoints-materialization-preview-create` first to confirm eligibility and see the rejection
  reason if any.
- **Endpoints are not stable forever.** When the user changes the query, a new version is
  created automatically (the old version stays accessible via `?version=N`). Cache TTL and
  materialisation are per-version. Adjust as the endpoint evolves.
