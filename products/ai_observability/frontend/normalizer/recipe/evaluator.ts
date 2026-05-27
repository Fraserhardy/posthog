// Evaluates a parsed `ValueExpr` against the current bindings and input.

import { HELPERS } from './helpers'
import { ValueExpr } from './ir'
import { parseStringifiedStructuredContentLocal } from './jsonHelpers'
import { Bindings } from './matcher'

export class ValueEvaluator {
    evaluate(expr: ValueExpr | unknown, bindings: Bindings, input: unknown): unknown {
        if (!isValueExpr(expr)) {
            return expr
        }
        switch (expr.tag) {
            case 'literal':
                return expr.value
            case 'self':
                return input
            case 'path':
                return readPath(input, expr.segments)
            case 'interp':
                return expr.parts
                    .map((part) =>
                        typeof part === 'string'
                            ? part
                            : String(this.evaluate(part as ValueExpr, bindings, input) ?? '')
                    )
                    .join('')
            case 'array':
                return expr.items.map((item) => this.evaluate(item, bindings, input))
            case 'object': {
                const out: Record<string, unknown> = {}
                for (const [k, v] of Object.entries(expr.fields)) {
                    out[k] = this.evaluate(v, bindings, input)
                }
                return out
            }
            case 'op':
                return this.applyOperator(expr.op, expr.args, bindings, input)
        }
    }

    private applyOperator(
        op: string,
        rawArgs: Record<string, ValueExpr | unknown>,
        bindings: Bindings,
        input: unknown
    ): unknown {
        // Each operator evaluates its own arguments: select/reject need to
        // defer `pluck` so it can run per-item, not against the outer input.
        const evalArg = (key: string): unknown =>
            rawArgs[key] === undefined ? undefined : this.evaluate(rawArgs[key] as ValueExpr, bindings, input)

        switch (op) {
            case 'coalesce': {
                const list = (evalArg('values') ?? evalArg('of')) as unknown[] | undefined
                if (!Array.isArray(list)) {
                    return undefined
                }
                return list.find((v) => v !== undefined && v !== null)
            }
            case 'select': {
                const arr = evalArg('from')
                if (!Array.isArray(arr)) {
                    return evalArg('if_empty') ?? []
                }
                const where = evalArg('where')
                const filtered = where ? arr.filter((item) => matchesWhere(item, where)) : arr
                const result = this.applyPluck(rawArgs.pluck as ValueExpr | undefined, filtered, bindings)
                return this.applyIfEmpty(result, rawArgs, evalArg)
            }
            case 'reject': {
                const arr = evalArg('from')
                if (!Array.isArray(arr)) {
                    return evalArg('if_empty') ?? []
                }
                const where = evalArg('where')
                const result = arr.filter((item) => !matchesWhere(item, where))
                return this.applyIfEmpty(result, rawArgs, evalArg)
            }
            case 'join': {
                const arr = evalArg('of')
                if (!Array.isArray(arr)) {
                    return ''
                }
                const sep = evalArg('sep')
                const field = evalArg('field')
                const sepStr = typeof sep === 'string' ? sep : '\n'
                if (typeof field === 'string') {
                    return arr.map((item) => readField(item, field) ?? '').join(sepStr)
                }
                return arr.map((item) => String(item ?? '')).join(sepStr)
            }
            case 'omit': {
                const from = evalArg('from')
                if (!from || typeof from !== 'object' || Array.isArray(from)) {
                    return {}
                }
                const rawKeys = evalArg('keys')
                const keys = Array.isArray(rawKeys) ? rawKeys.filter((k): k is string => typeof k === 'string') : []
                const out: Record<string, unknown> = { ...(from as Record<string, unknown>) }
                for (const k of keys) {
                    delete out[k]
                }
                return out
            }
            case 'try_parse_structured_content': {
                const value = evalArg('input')
                return typeof value === 'string' ? parseStringifiedStructuredContentLocal(value) : value
            }
            case 'helper': {
                const name = evalArg('name')
                const fn = typeof name === 'string' ? HELPERS[name] : undefined
                if (!fn) {
                    throw new Error(`Unknown helper: ${String(name)}`)
                }
                return fn(evalArg('input'))
            }
            default:
                throw new Error(`Unknown operator: ${op}`)
        }
    }

    // `pluck` is deferred so its `$.foo` paths can read from each array element.
    private applyPluck(pluckExpr: ValueExpr | undefined, items: unknown[], bindings: Bindings): unknown[] {
        if (pluckExpr === undefined) {
            return items
        }
        if (isStringLiteral(pluckExpr)) {
            return items.map((item) => readField(item, pluckExpr.value as string))
        }
        return items.map((item) => this.evaluate(pluckExpr, bindings, item))
    }

    // YAML `~` → JS null → mapped to undefined here so downstream slots drop the field.
    private applyIfEmpty(
        result: unknown[],
        rawArgs: Record<string, ValueExpr | unknown>,
        evalArg: (key: string) => unknown
    ): unknown {
        if (result.length !== 0 || rawArgs.if_empty === undefined) {
            return result
        }
        const fallback = evalArg('if_empty')
        return fallback === null ? undefined : fallback
    }
}

function isStringLiteral(expr: ValueExpr): expr is { tag: 'literal'; value: string } {
    return expr.tag === 'literal' && typeof expr.value === 'string'
}

function isValueExpr(value: unknown): value is ValueExpr {
    return !!value && typeof value === 'object' && 'tag' in (value as object)
}

function readPath(input: unknown, segments: string[]): unknown {
    let cursor: unknown = input
    for (const seg of segments) {
        if (cursor && typeof cursor === 'object' && seg in (cursor as object)) {
            cursor = (cursor as Record<string, unknown>)[seg]
        } else {
            return undefined
        }
    }
    return cursor
}

function readField(input: unknown, field: string): unknown {
    if (input && typeof input === 'object' && field in (input as object)) {
        return (input as Record<string, unknown>)[field]
    }
    return undefined
}

function matchesWhere(item: unknown, where: unknown): boolean {
    if (!where || typeof where !== 'object') {
        return false
    }
    for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
        if (readField(item, k) !== v) {
            return false
        }
    }
    return true
}
