// Compiles loose parsed YAML into the strict recipe IR. This is the single
// place that interprets recipe conventions (bare value = equality, verb keys
// in `on:`, `$.foo` paths and operator calls in `emit:`).

import {
    EmitSpec,
    FieldPredicate,
    FollowupSpec,
    Pattern,
    Provider,
    ProviderKind,
    Rule,
    RoleTag,
    TypeName,
    ValueExpr,
} from '../ir'

const PREDICATE_VERBS = new Set(['equals', 'exists', 'is', 'in', 'shape', 'every'])
const ROLE_TAGS: ReadonlySet<RoleTag> = new Set(['user', 'assistant', 'system', 'tool', 'thinking', 'tool_result'])
const TYPE_NAMES: ReadonlySet<TypeName> = new Set(['string', 'array', 'object', 'null', 'number', 'boolean', 'any'])
// Operators whose payload is a mapping of named args (the common case).
const MAPPING_OPERATORS = new Set(['select', 'reject', 'join', 'omit', 'helper'])

export function compileProvider(raw: unknown): Provider {
    if (!isObject(raw)) {
        throw new Error(`Provider YAML must be a mapping at top level`)
    }
    const id = stringField(raw, 'id') ?? stringField(raw, 'provider')
    if (!id) {
        throw new Error(`Provider is missing 'id' (or 'provider:') key`)
    }
    const rulesRaw = raw.rules
    if (!Array.isArray(rulesRaw)) {
        throw new Error(`Provider '${id}' is missing a 'rules:' sequence`)
    }
    return {
        id,
        kind: (stringField(raw, 'kind') as ProviderKind | undefined) ?? 'chat',
        priority: numField(raw, 'priority') ?? 100,
        capture: stringField(raw, 'capture'),
        rules: rulesRaw.map((r, i) => {
            try {
                return compileRule(r)
            } catch (err) {
                throw new Error(`Provider '${id}' rule[${i}]: ${err instanceof Error ? err.message : String(err)}`)
            }
        }),
    }
}

function compileRule(raw: unknown): Rule {
    if (!isObject(raw)) {
        throw new Error(`rule must be a mapping`)
    }
    if (!isObject(raw.on)) {
        throw new Error(`rule.on must be a mapping`)
    }
    const rule: Rule = { on: compilePattern(raw.on) }
    if (raw.emit !== undefined) {
        rule.emit = compileEmitSpec(raw.emit)
    }
    if (raw.delegate !== undefined) {
        rule.delegate = compileValue(raw.delegate)
    }
    if (raw.delegateEach !== undefined) {
        rule.delegateEach = compileValue(raw.delegateEach)
    }
    if (raw.stamp !== undefined) {
        rule.stamp = compileEmitSpec(raw.stamp)
    }
    if (raw.followups !== undefined) {
        if (!Array.isArray(raw.followups)) {
            throw new Error(`rule.followups must be a sequence`)
        }
        rule.followups = raw.followups.map(compileFollowup)
    }
    return rule
}

function compileFollowup(raw: unknown): FollowupSpec {
    if (!isObject(raw)) {
        throw new Error(`followup entry must be a mapping`)
    }
    // Expand form: each array element becomes its own followup message.
    if ('from' in raw && 'each' in raw) {
        if (!isObject(raw.each)) {
            throw new Error(`'each:' in followup must be a mapping`)
        }
        return { kind: 'expand', from: compileValue(raw.from), each: compileEmitSpec(raw.each) }
    }
    return { kind: 'static', emit: compileEmitSpec(raw) }
}

function compilePattern(raw: Record<string, unknown>): Pattern {
    const out: Pattern = {}
    for (const [key, value] of Object.entries(raw)) {
        out[key] = compilePredicate(value)
    }
    return out
}

function compilePredicate(raw: unknown): FieldPredicate {
    if (isObject(raw)) {
        const verb = Object.keys(raw).find((k) => PREDICATE_VERBS.has(k))
        if (verb) {
            return buildPredicateFromVerb(verb, raw[verb])
        }
        // Plain nested object = shape predicate (recursive match).
        return { kind: 'shape', nested: compilePattern(raw) }
    }
    // Bare scalar/array = equality check.
    return { kind: 'equals', value: raw }
}

function buildPredicateFromVerb(verb: string, value: unknown): FieldPredicate {
    switch (verb) {
        case 'equals':
            return { kind: 'equals', value }
        case 'exists':
            return { kind: 'exists', present: Boolean(value) }
        case 'is': {
            const arr = Array.isArray(value) ? value : [value]
            const types: TypeName[] = []
            for (const t of arr) {
                // YAML bare `null` parses as JS null, but inside `is: [...]` the
                // author meant the type name 'null'. Normalize either to 'null'.
                const name = t === null ? 'null' : t
                if (typeof name !== 'string' || !TYPE_NAMES.has(name as TypeName)) {
                    throw new Error(`'is:' must be a type or array of types, got ${JSON.stringify(value)}`)
                }
                types.push(name as TypeName)
            }
            return { kind: 'is', types }
        }
        case 'in':
            if (!Array.isArray(value)) {
                throw new Error(`'in:' must be an array`)
            }
            return { kind: 'in', values: value }
        case 'shape':
            if (!isObject(value)) {
                throw new Error(`'shape:' must be a mapping`)
            }
            return { kind: 'shape', nested: compilePattern(value) }
        case 'every':
            return { kind: 'every', element: compilePredicate(value) }
        default:
            throw new Error(`Unknown predicate verb '${verb}'`)
    }
}

function compileEmitSpec(raw: unknown): EmitSpec {
    if (!isObject(raw)) {
        throw new Error(`emit must be a mapping`)
    }
    const out: EmitSpec = {}
    for (const [k, v] of Object.entries(raw)) {
        switch (k) {
            case 'role':
                out.role = typeof v === 'string' && ROLE_TAGS.has(v as RoleTag) ? (v as RoleTag) : compileValue(v)
                break
            case 'content':
                out.content = compileValue(v)
                break
            case 'toolCall':
                out.toolCall = compileValue(v)
                break
            case 'toolCalls':
                out.toolCalls = compileValue(v)
                break
            // Accept both camelCase and snake_case for the YAML key.
            case 'toolCallId':
            case 'tool_call_id':
                out.toolCallId = compileValue(v)
                break
            case 'spread':
                out.spread = compileValue(v)
                break
            default:
                throw new Error(`Unknown emit key '${k}'`)
        }
    }
    return out
}

function compileValue(raw: unknown): ValueExpr {
    if (raw === null || raw === undefined) {
        return { tag: 'literal', value: null }
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
        return { tag: 'literal', value: raw }
    }
    if (typeof raw === 'string') {
        return compileStringValue(raw)
    }
    if (Array.isArray(raw)) {
        return { tag: 'array', items: raw.map(compileValue) }
    }
    if (isObject(raw)) {
        // `{ <op>: <payload> }` with a single reserved key is an operator call.
        const keys = Object.keys(raw)
        if (keys.length === 1 && isOperatorKey(keys[0])) {
            return compileOperator(keys[0], raw[keys[0]])
        }
        const fields: Record<string, ValueExpr> = {}
        for (const [k, v] of Object.entries(raw)) {
            fields[k] = compileValue(v)
        }
        return { tag: 'object', fields }
    }
    return { tag: 'literal', value: raw }
}

function isOperatorKey(key: string): boolean {
    return MAPPING_OPERATORS.has(key) || key === 'coalesce' || key === 'try_parse_structured_content'
}

// Conservative match: `$.foo.bar.a_b_2`. Avoids picking up `$` in URLs or
// arbitrary text containing a dollar sign.
const INTERP_RE = /\$\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g

function compileStringValue(s: string): ValueExpr {
    if (s === '$') {
        return { tag: 'self' }
    }
    if (/^\$\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(s)) {
        return { tag: 'path', segments: s.slice(2).split('.').filter(Boolean) }
    }
    if (s.startsWith('$') && /^[$][A-Za-z_]/.test(s)) {
        throw new Error(
            `'${s}' is not a valid value expression. Use '$.${s.slice(1)}' for a field read, or '$' for the whole input.`
        )
    }
    INTERP_RE.lastIndex = 0
    if (INTERP_RE.test(s)) {
        return compileInterp(s)
    }
    return { tag: 'literal', value: s }
}

function compileInterp(s: string): ValueExpr {
    const parts: (string | ValueExpr)[] = []
    INTERP_RE.lastIndex = 0
    let cursor = 0
    let m: RegExpExecArray | null
    while ((m = INTERP_RE.exec(s)) !== null) {
        if (m.index > cursor) {
            parts.push(s.slice(cursor, m.index))
        }
        parts.push({ tag: 'path', segments: m[1].split('.') })
        cursor = m.index + m[0].length
    }
    if (cursor < s.length) {
        parts.push(s.slice(cursor))
    }
    return { tag: 'interp', parts }
}

function compileOperator(op: string, payload: unknown): ValueExpr {
    const args: Record<string, ValueExpr> = {}

    // Coalesce accepts a shorthand array form OR a {values: [...]} mapping.
    if (op === 'coalesce') {
        if (Array.isArray(payload)) {
            args.values = { tag: 'array', items: payload.map(compileValue) }
            return { tag: 'op', op, args }
        }
        if (!isObject(payload)) {
            throw new Error(`'coalesce:' takes an array or {values: [...]}`)
        }
        for (const [k, v] of Object.entries(payload)) {
            args[k] = compileValue(v)
        }
        return { tag: 'op', op, args }
    }

    // try_parse_structured_content takes a bare value as its single arg.
    if (op === 'try_parse_structured_content') {
        args.input = compileValue(payload)
        return { tag: 'op', op, args }
    }

    // The remaining operators all take a mapping of named args.
    if (!isObject(payload)) {
        throw new Error(`'${op}:' takes a mapping`)
    }
    for (const [k, v] of Object.entries(payload)) {
        args[k] = compileValue(v)
    }
    return { tag: 'op', op, args }
}

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v)
}

function stringField(o: Record<string, unknown>, key: string): string | undefined {
    return typeof o[key] === 'string' ? (o[key] as string) : undefined
}

function numField(o: Record<string, unknown>, key: string): number | undefined {
    return typeof o[key] === 'number' ? (o[key] as number) : undefined
}
