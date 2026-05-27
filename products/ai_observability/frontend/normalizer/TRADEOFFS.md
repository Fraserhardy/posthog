# Recipe normalizer — tradeoffs and open work

This document captures the deliberate shortcuts taken during the initial
recipe-port. None of them block the test suite — both columns of
`describe.each([{name:'legacy'}, {name:'recipe'}])` are green for all 215
test cases (430 total). They're listed here because they're places where
the design intentionally lags the master plan and we should be honest
about it.

## 1. Recipes live in `*.yaml` files; loaded via a hand-rolled parser

Recipes are authored as YAML under `recipe/providers/yaml/`. We had to
hand-roll a tiny parser (`recipe/yaml/parser.ts`) because the sandbox
couldn't reach the npm registry to pull `js-yaml`. The parser handles the
subset our recipes use (block + flow mappings/sequences, scalars, comments)
but **does not** support:

- anchors / aliases (`&` / `*`)
- tags (`!!str`)
- multi-line scalars (`|`, `>`)
- multi-document streams (`---`)
- complex keys
- non-`#` style comments

The loose YAML output is then run through `recipe/yaml/compiler.ts` which
maps it to the strict IR (`Provider` / `Rule` / `Pattern` / etc.).

Drop-in replacement plan: when `js-yaml` is installed, replace the body of
`parseYaml` with `yaml.load(source)` and delete the hand-rolled parser. The
compiler stays.

YAML loading uses `node:fs` at module-init time. This is correct for Jest
but won't work in the browser bundle — when we wire prod adoption behind a
feature flag, swap to Vite's `?raw` import or a `vite-plugin-yaml`-style
loader that produces the parsed IR at build time.

## 2. Full coverage — no legacy fallback

The recipe pipeline now handles every shape the legacy `normalizeMessage`
did. `cajole.yaml` is the lowest-priority catch-all (priority 1000) and
matches `$: { exists: true }` so the pipeline always produces a result.
If anything reaches the post-pipeline branch in `RecipeNormalizer`, we
throw — it's a coverage bug, not a graceful degradation.

Providers ported, in dispatch order:

- `compat_array` (priority 5) — role+content[] with typed-block allowlist
- `litellm` (10) — choice unwrapping
- `langchain_envelope` (15) — `{lc:1, type:'constructor', kwargs}` shape (new)
- `vercel_sdk` (30) — text / input_text / input_image / image / tool-call (both variants) / tool-result
- `openai_chat` (35) — `{role, content: string|null, ...}` with spread + stringified-structured-content heuristic
- `openai_responses` (40) — function_call / function_call_output / reasoning / built-in tool calls
- `anthropic` (50) — text / thinking / tool_use / tool_result (array+scalar) / image / document / role-based envelope (with and without top-level tool_calls)
- `otel` (60) — parts aggregation with `followups:` for tool_call_response messages
- `langchain` (20) — bare type-discriminated message (no role)
- `wrappers` (90) — `{content}` / `{message}` / `{text}` single-field shapes (new)
- `cajole` (1000) — bare string / object-with-string-content / stringify-fallback, fires `posthog.capture` on match

## 3. `parseToolArguments` / `parseStringifiedStructuredContent` duplicated

These two helpers are private to `utils.ts`. To honor "leave `utils.ts`
exactly as-is" we kept reimplementations in
`normalizer/recipe/jsonHelpers.ts` (`parseToolArgumentsLocal`,
`parseStringifiedStructuredContentLocal`). The bodies are identical to the
originals. If we ever flip the recipe path to be the only one, collapsing
the two implementations into one shared module is a 3-line PR.

## 4. Symbolic role tags vs literal UI labels

Recipes emit role tags like `'thinking'` / `'tool_result'`. The
`SlotCoercer` currently maps them to the literal renderer-facing strings
(`'assistant (thinking)'` / `'assistant (tool result)'`) so output matches
legacy. That's the Layer-3 work we discussed: when the renderer learns
the symbolic role, the coercer's translation table goes away and the IR
stays clean.

## 5. `compat_array` matches via `every` predicate, content split via helpers

The block-allowlist check (`every element has type in <set>`) uses a new
`every` predicate kind; the split into `content` (non-function blocks)
and `tool_calls` (function blocks lifted to OpenAI shape) lives in two
helper functions (`compat_array_content`, `compat_array_tool_calls`)
called via the `helper:` operator.

Doing the split structurally (`filter:` + `map:` + collapse-empty) would
mean inventing three more operators and an emit-merge rule for an `''`
fallback. The helper approach keeps the runtime small and the procedural
quirks localized to one file.

## 6. The OpenAI Responses built-in tool args also uses a helper

Same rationale as `compat_array`: the legacy branch is
parse-if-string / wrap-if-non-object / spread-rest-with-omit-list. The
spread-with-omit branch in particular wouldn't simplify under any DSL
operator I could think of — it's procedural by nature. Helper:
`openai_responses_builtin_args` in `helpers.ts`.

## 7. No shadow-mode reporter wired up yet

The master plan called for a `ShadowNormalizer` that runs both impls and
ships divergence reports to PostHog. That's deferred to "after the recipe
pipeline is the default in dev" — wiring it up now would just be unused
code. The test suite already serves the same purpose offline (any
divergence shows up as a failure on one column).

## 8. The "every" predicate test currently passes any element matcher

`every` accepts any `FieldPredicate` and applies it to each array
element. The way this composes with `shape:` covers the only use case we
have (typed-block allowlist), but the second arg of `testPredicate` —
`present` — is set to `item !== undefined`, which is OK for our shapes but
slightly inconsistent with the rest of the matcher. If we ever need
`every: { exists: false }`, revisit.
