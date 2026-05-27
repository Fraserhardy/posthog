// The recipe pipeline orchestrates dispatch over an ordered list of providers.

import posthog from 'posthog-js'

import { CompatMessage } from '../../types'
import { SlotCoercer } from './coercion'
import { ValueEvaluator } from './evaluator'
import { FollowupSpec, Provider, Rule } from './ir'
import { Bindings, PatternMatcher } from './matcher'

export class RecipePipeline {
    private readonly matcher = new PatternMatcher()
    private readonly evaluator = new ValueEvaluator()
    private readonly coercer = new SlotCoercer()

    constructor(private readonly providers: Provider[]) {
        this.providers.sort((a, b) => a.priority - b.priority)
    }

    run(input: unknown, defaultRole: string): CompatMessage[] | undefined {
        // Seed with a synthetic parent so children inherit a resolved $role
        // and we don't need to thread `defaultRole` through every call.
        const rootParent: Bindings = { $root: input, $role: defaultRole }
        return this.dispatch(input, input, rootParent)
    }

    private dispatch(input: unknown, root: unknown, parent: Bindings): CompatMessage[] | undefined {
        for (const provider of this.providers) {
            for (const rule of provider.rules) {
                const result = this.applyRule(rule, input, root, parent)
                if (result !== undefined) {
                    if (provider.capture) {
                        posthog.capture(provider.capture, {
                            message_keys: typeof input === 'object' && input !== null ? Object.keys(input) : [],
                            message_type: typeof input,
                        })
                    }
                    return result
                }
            }
        }
        return undefined
    }

    private applyRule(rule: Rule, input: unknown, root: unknown, parent: Bindings): CompatMessage[] | undefined {
        const bindings = this.matcher.match(input, rule.on, { root, parent })
        if (!bindings) {
            return undefined
        }

        // Compute followups first: their presence determines whether the
        // primary may drop on emptiness (OTel "responses-only" case).
        const followups = this.buildFollowups(rule.followups ?? [], bindings, input)
        const allowPrimaryDrop = followups.length > 0

        const primary = this.runPrimary(rule, bindings, input, root, allowPrimaryDrop)
        if (primary === undefined) {
            return undefined
        }
        primary.push(...followups)
        return primary
    }

    private runPrimary(
        rule: Rule,
        bindings: Bindings,
        input: unknown,
        root: unknown,
        allowDrop: boolean
    ): CompatMessage[] | undefined {
        if (rule.delegate) {
            const nextInput = this.evaluator.evaluate(rule.delegate, bindings, input)
            return this.dispatch(nextInput, root, bindings)
        }
        if (rule.delegateEach) {
            const arr = this.evaluator.evaluate(rule.delegateEach, bindings, input)
            if (!Array.isArray(arr)) {
                return undefined
            }
            const messages: CompatMessage[] = []
            for (const item of arr) {
                const sub = this.dispatch(item, root, bindings)
                if (sub === undefined) {
                    return undefined
                }
                messages.push(...sub)
            }
            if (!rule.stamp) {
                return messages
            }
            return messages.map((msg) => this.coercer.stamp(msg, rule.stamp!, bindings, input, this.evaluator))
        }
        if (rule.emit) {
            const message = this.coercer.buildMessage(rule.emit, bindings, input, this.evaluator, allowDrop)
            return message ? [message] : []
        }
        throw new Error('Rule must set one of: emit, delegate, delegateEach')
    }

    private buildFollowups(followups: FollowupSpec[], bindings: Bindings, input: unknown): CompatMessage[] {
        const messages: CompatMessage[] = []
        for (const f of followups) {
            if (f.kind === 'static') {
                const msg = this.coercer.buildMessage(f.emit, bindings, input, this.evaluator)
                if (msg) {
                    messages.push(msg)
                }
                continue
            }
            const arr = this.evaluator.evaluate(f.from, bindings, input)
            if (!Array.isArray(arr)) {
                continue
            }
            // Inside `each:`, the item becomes the input — `$.field` reads
            // from the array element, `$` refers to the whole element.
            for (const item of arr) {
                const msg = this.coercer.buildMessage(f.each, bindings, item, this.evaluator)
                if (msg) {
                    messages.push(msg)
                }
            }
        }
        return messages
    }
}
