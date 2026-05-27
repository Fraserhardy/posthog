// Pattern matching for recipe rules. Returns a fresh Bindings on match, null otherwise.

import { normalizeRole, roleMap } from '../../utils'
import { FieldPredicate, Pattern, TypeName } from './ir'

export interface Bindings {
    readonly $root: unknown
    readonly $role: string
    readonly $parent?: Bindings
    readonly [name: string]: unknown
}

interface MatchContext {
    root: unknown
    parent: Bindings | undefined
}

export class PatternMatcher {
    match(input: unknown, pattern: Pattern, ctx: MatchContext): Bindings | null {
        for (const [field, predicate] of Object.entries(pattern)) {
            const value = this.readField(input, field)
            const present = this.isPresent(input, field)
            if (!this.testPredicate(value, present, predicate, ctx)) {
                return null
            }
        }
        return {
            $root: ctx.root,
            $role: this.resolveRole(input, ctx.parent?.$role ?? 'user'),
            $parent: ctx.parent,
        }
    }

    private resolveRole(input: unknown, defaultRole: string): string {
        if (!input || typeof input !== 'object') {
            return defaultRole
        }
        const obj = input as Record<string, unknown>
        if (typeof obj.role === 'string') {
            return normalizeRole(obj.role, defaultRole)
        }
        if (typeof obj.type === 'string' && Object.hasOwn(roleMap, obj.type)) {
            return normalizeRole(obj.type, defaultRole)
        }
        return defaultRole
    }

    private readField(input: unknown, field: string): unknown {
        if (field === '$') {
            return input
        }
        if (input && typeof input === 'object' && field in input) {
            return (input as Record<string, unknown>)[field]
        }
        return undefined
    }

    private isPresent(input: unknown, field: string): boolean {
        if (field === '$') {
            return input !== undefined
        }
        return !!input && typeof input === 'object' && field in input
    }

    private testPredicate(value: unknown, present: boolean, predicate: FieldPredicate, ctx: MatchContext): boolean {
        switch (predicate.kind) {
            case 'equals':
                return present && value === predicate.value
            case 'exists':
                return present === predicate.present
            case 'is':
                return present && this.matchesAnyType(value, predicate.types)
            case 'in':
                return present && predicate.values.includes(value)
            case 'shape':
                if (!present || !value || typeof value !== 'object') {
                    return false
                }
                return this.match(value, predicate.nested, ctx) !== null
            case 'every':
                if (!present || !Array.isArray(value) || value.length === 0) {
                    return false
                }
                return value.every((item) => this.testPredicate(item, item !== undefined, predicate.element, ctx))
        }
    }

    private matchesAnyType(value: unknown, types: TypeName[]): boolean {
        return types.some((type) => this.matchesType(value, type))
    }

    private matchesType(value: unknown, type: TypeName): boolean {
        switch (type) {
            case 'any':
                return true
            case 'string':
                return typeof value === 'string'
            case 'number':
                return typeof value === 'number'
            case 'boolean':
                return typeof value === 'boolean'
            case 'null':
                return value === null
            case 'array':
                return Array.isArray(value)
            case 'object':
                return value !== null && typeof value === 'object' && !Array.isArray(value)
        }
    }
}
