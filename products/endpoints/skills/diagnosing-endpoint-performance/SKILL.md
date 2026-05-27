---
name: diagnosing-endpoint-performance
description: >
  Diagnose why a PostHog endpoint is slow or expensive and propose a concrete fix — bump the cache
  TTL, enable materialisation, restructure variables, or rewrite the query. Use when the user says
  "this endpoint is slow", "my endpoint times out", "we're hitting the cost cap on this one", or
  asks "should I materialise this?". Focuses on a single named endpoint, not a project-wide audit.
---

# Diagnosing endpoint performance

This skill walks through a specific endpoint that is slow, expensive, or unreliable, and produces
a concrete recommendation. It is the deep-dive counterpart to `auditing-endpoints` (which finds
candidates).

## When to use this skill

- "This endpoint is slow / timing out"
- "Why is my endpoint hitting the cost cap?"
- "Should I materialise X?"
- An endpoint surfaced from `auditing-endpoints` as a failing materialisation or expensive caller
- The user has a specific endpoint in mind and wants advice

If the question is project-wide ("what should I clean up?"), use `auditing-endpoints` first.

## Available tools

| Tool                                             | Purpose                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `endpoint-get`                                   | Full endpoint config: query, current version, cache TTL, materialisation status      |
| `endpoint-versions`                              | History of every version — useful to see if the query changed recently               |
| `endpoint-materialization-status`                | Whether materialisation is eligible, current state, last run, last error             |
| `endpoints-materialization-preview-create`       | What the materialised query would look like, plus the rejection reason if ineligible |
| `endpoints-last-execution-times-create`          | When was it last called (sanity-check it is in active use)                           |
| `endpoints-versions-last-execution-times-create` | Per-version recency — is the slow version actually the called one?                   |

## The decision tree

When deciding what to recommend, walk these in order — the first one that applies is the cheapest
fix.

### Step 1 — Is it cached at all?

Fetch the endpoint and look at `data_freshness_seconds` (the cache TTL). If the user's traffic
calls the same parameters repeatedly within that window, every call after the first is a cache
hit and effectively free.

- TTL is at the default (24h / 86400s) and the data really doesn't need fresher than that →
  done, no change needed.
- TTL is short (60s or less) and the user is hitting the endpoint many times per minute → bump
  the TTL. This is almost always the cheapest first move.
- TTL is short _because the data must be fresh_ (e.g. real-time dashboard) → cache won't help,
  skip to step 2.

The shape of the variables matters here: if every call passes different `user_id` or `date_from`
values, the cache has many distinct keys and a higher TTL helps less. If almost every call uses
the same handful of parameter combinations, the cache helps a lot.

### Step 2 — Should it be materialised?

Materialisation pre-computes the query into a saved view that's refreshed on a schedule. Reads
become near-instant — at the cost of staleness equal to the refresh interval, plus storage and
compute for the materialisation itself.

Call `endpoints-materialization-preview-create`. The response tells you:

- **Eligible + clean transform** → strong candidate. Recommend enabling, especially for
  endpoints with predictable filter shapes (variables, breakdowns).
- **Not eligible**, with a rejection reason → cannot materialise. The reason often hints at the
  next step (see step 3 — rewrite).
- **Eligible but the transform is gnarly** (lots of range pairs, complex aggregation
  re-derivation) → materialisation will work but may not save much. Worth flagging before
  flipping the switch.

When materialisation is enabled, callers **must pass all materialised variables** — calls without
them are rejected (security: prevents returning unfiltered data). Pair the recommendation with
a note about which variables become required.

### Step 3 — Does the query need rewriting?

If the endpoint isn't eligible for materialisation, the rejection reason from
`endpoints-materialization-preview-create` is usually the lead:

- **"Has breakdowns" / breakdown rejection** → for insight endpoints, breakdowns block
  materialisation. If the user only needs one or two breakdown values, suggest splitting into
  separate endpoints with each as a variable instead.
- **"Missing variables" / unbounded scan** → the query reads too much data without a filter.
  Encourage adding a required time-window variable (e.g. `date_from`, `lookback_days`).
- **HogQL with `*` / non-deterministic functions** → narrow the columns selected, replace
  `now()` / `today()` with a variable when possible.

Check `endpoint-versions` to see whether the query was recently changed. Often the regression
came from a specific commit and reverting that version is faster than rewriting.

### Step 4 — Is the slow version even the one being called?

Call `endpoints-versions-last-execution-times-create`. If the slowest version (per the user's
report) is not the one actually being executed, the fix may be just to delete or unmaterialise
the dead version rather than tuning the query.

## Workflow

1. Identify the endpoint by name. If the user gave a URL, parse the name from
   `/api/environments/{team_id}/endpoints/{name}/run`.
2. `endpoint-get` to fetch full config. Note: `data_freshness_seconds`, `is_materialized`,
   current version, query kind.
3. `endpoint-materialization-status` to see materialisation health (failed? eligible?).
4. `endpoints-versions-last-execution-times-create` with just this endpoint name to see which
   version(s) are actually being called.
5. If the user gave specific symptoms ("times out", "memory limit", "very slow"), walk the
   decision tree above. Otherwise, present the four checkpoints and ask which matches.
6. End with a concrete recommendation — bump TTL, materialise, rewrite, or rollback — and
   confirm before applying it.

## Example interaction

```text
User: "monthly_active_users is timing out for some callers"

Agent steps:
- endpoint-get monthly_active_users → HogQL endpoint, data_freshness_seconds=60,
  is_materialized=false, current version v4
- endpoint-materialization-status monthly_active_users → not materialised; eligible: true
- endpoints-versions-last-execution-times-create with ['monthly_active_users']
  → v4 called 14k times in last 6 months
- endpoints-materialization-preview-create → eligible, clean transform with one range pair

- "Three things stand out:
   1. Cache TTL is 60 seconds, but the data is aggregating a month —
      that aggressive a refresh probably isn't necessary. Bumping to
      1 hour (3600s) would dramatically reduce ClickHouse load.
   2. It's eligible for materialisation with a clean transform. If
      callers can tolerate 5-15 minute staleness, materialisation
      would make reads near-instant.
   3. Only v4 is called, so there's no dead version blocking work.

   Quickest win: bump TTL to 3600s. Bigger win: materialise.

   Which trade-off matches your needs? If you need real-time freshness,
   neither helps and we'd need to rewrite the query — likely narrowing
   the aggregation window."
```

## Important notes

- **Cache is almost always the first fix.** It's free, instantly reversible, and doesn't change
  data semantics. Resist jumping to materialisation if a higher TTL would do.
- **Materialisation has hidden costs.** Storage of the materialised view, refresh compute, and
  the requirement that callers pass all variables. Don't recommend lightly.
- **Don't rewrite the query without the user.** A query change creates a new version and may
  break callers. Surface the suggested change, get sign-off, then apply.
- **Per-version usage scope is limited.** Usage tools filter to personal API key calls within
  the last 6 months. A version exercised only from the playground will look unused.
- **The "right" fix depends on the SLA, not the query.** Always ask the user about acceptable
  staleness before recommending materialisation. A 15-minute-stale materialised view is wrong
  for a real-time dashboard, regardless of how cheap it'd be.
