// Slot coercion: normalizes whatever a recipe produced into the fixed
// CompatMessage shape, so rules don't have to repeat the same type checks.

import { CompatMessage, CompatToolCall, MultiModalContentItem } from '../../types'
import { isOpenAICompatToolCallsArray, normalizeRole, parseOpenAIToolCalls } from '../../utils'
import { ValueEvaluator } from './evaluator'
import { EmitSpec, RoleTag, ValueExpr } from './ir'
import { parseToolArgumentsLocal as parseToolArguments } from './jsonHelpers'
import { Bindings } from './matcher'

// The two UI-shaped tags currently route through `normalizeRole` for renderer
// compatibility. Layer-3 will eventually let the renderer consume the symbolic
// tag directly so these mappings can go away.
const ROLE_TAGS: Record<RoleTag, string> = {
    user: 'user',
    assistant: 'assistant',
    system: 'system',
    tool: 'tool',
    thinking: 'assistant (thinking)',
    tool_result: 'assistant (tool result)',
}

export class SlotCoercer {
    buildMessage(
        emit: EmitSpec,
        bindings: Bindings,
        input: unknown,
        evaluator: ValueEvaluator,
        allowDrop: boolean = false
    ): CompatMessage | null {
        // Spread first so explicit fields can override it.
        let base: Partial<CompatMessage> = {}
        if (emit.spread !== undefined) {
            const spread = evaluator.evaluate(emit.spread as ValueExpr, bindings, input)
            if (spread && typeof spread === 'object' && !Array.isArray(spread)) {
                base = { ...(spread as Record<string, unknown>) } as Partial<CompatMessage>
            }
        }

        base.role = this.coerceRole(emit.role, bindings, input, evaluator)

        if (emit.content !== undefined) {
            base.content = this.coerceContent(evaluator.evaluate(emit.content, bindings, input))
        }
        if (emit.toolCallId !== undefined) {
            const id = evaluator.evaluate(emit.toolCallId, bindings, input)
            if (typeof id === 'string') {
                base.tool_call_id = id
            }
        }
        if (emit.toolCall !== undefined) {
            const normalized = this.coerceSingleToolCall(evaluator.evaluate(emit.toolCall, bindings, input))
            if (normalized) {
                base.tool_calls = [normalized]
            }
        }
        if (emit.toolCalls !== undefined) {
            // Explicit override: assigning `undefined` clears any value the
            // spread may have put there.
            base.tool_calls = this.coerceToolCalls(evaluator.evaluate(emit.toolCalls, bindings, input))
        }

        const isEmpty =
            base.content === undefined &&
            base.tool_calls === undefined &&
            base.tool_call_id === undefined &&
            (base as { tools?: unknown }).tools === undefined

        // Empty messages drop only when the rule opts in (it has followups —
        // the OTel "responses-only" case). Otherwise empty `content` defaults
        // to '' so downstream renderers don't crash on undefined.
        if (allowDrop && isEmpty) {
            return null
        }
        if (base.content === undefined) {
            base.content = ''
        }
        return base as CompatMessage
    }

    // Merge role/tool_call_id onto messages produced by `delegateEach` — the
    // Anthropic tool_result pattern: child blocks normalize independently, then
    // we attach the parent's metadata.
    stamp(
        message: CompatMessage,
        emit: EmitSpec,
        bindings: Bindings,
        input: unknown,
        evaluator: ValueEvaluator
    ): CompatMessage {
        const stamped: CompatMessage = { ...message }
        if (emit.role !== undefined) {
            stamped.role = this.coerceRole(emit.role, bindings, input, evaluator)
        }
        if (emit.toolCallId !== undefined) {
            const id = evaluator.evaluate(emit.toolCallId, bindings, input)
            if (typeof id === 'string') {
                stamped.tool_call_id = id
            }
        }
        return stamped
    }

    private coerceRole(
        roleExpr: EmitSpec['role'],
        bindings: Bindings,
        input: unknown,
        evaluator: ValueEvaluator
    ): string {
        const defaultRole = bindings.$role ?? 'user'
        if (roleExpr === undefined) {
            return defaultRole
        }
        if (typeof roleExpr === 'string' && roleExpr in ROLE_TAGS) {
            return normalizeRole(ROLE_TAGS[roleExpr as RoleTag], defaultRole)
        }
        const evaluated = evaluator.evaluate(roleExpr as ValueExpr, bindings, input)
        if (typeof evaluated === 'string') {
            return normalizeRole(evaluated, defaultRole)
        }
        return defaultRole
    }

    private coerceContent(value: unknown): CompatMessage['content'] | undefined {
        if (value === undefined) {
            return undefined
        }
        if (value === null) {
            // Legacy OpenAI tool-call messages keep null content; the slot
            // type doesn't model null but the runtime path needs to.
            return null as never
        }
        if (typeof value === 'string') {
            return value
        }
        if (Array.isArray(value)) {
            // Array of bare strings → 1 unwraps to a string, n wraps each as a
            // text part (OTel's text-parts collapse). Empty and mixed/object
            // arrays pass through unchanged. Recipes that want empty-as-drop
            // use `if_empty: ~` on the producing operator.
            if (value.length > 0 && value.every((v) => typeof v === 'string')) {
                if (value.length === 1) {
                    return value[0]
                }
                return value.map((text) => ({ type: 'text' as const, text: text as string }))
            }
            return value as MultiModalContentItem[]
        }
        try {
            return JSON.stringify(value)
        } catch {
            return String(value)
        }
    }

    private coerceToolCalls(value: unknown): CompatToolCall[] | undefined {
        if (!Array.isArray(value) || value.length === 0) {
            return undefined
        }
        if (isOpenAICompatToolCallsArray(value)) {
            return parseOpenAIToolCalls(value)
        }
        const calls: CompatToolCall[] = []
        for (const item of value) {
            const normalized = this.coerceSingleToolCall(item)
            if (normalized) {
                calls.push(normalized)
            }
        }
        return calls.length > 0 ? calls : undefined
    }

    private coerceSingleToolCall(value: unknown): CompatToolCall | null {
        if (!value || typeof value !== 'object') {
            return null
        }
        const obj = value as Record<string, unknown>
        if (obj.type === 'function' && obj.function && typeof obj.function === 'object') {
            const fn = obj.function as { name: unknown; arguments?: unknown }
            if (typeof fn.name !== 'string') {
                return null
            }
            return {
                type: 'function',
                id: typeof obj.id === 'string' ? obj.id : undefined,
                function: {
                    name: fn.name,
                    arguments: parseToolArguments((fn.arguments ?? {}) as string | Record<string, unknown>),
                },
            }
        }
        if (typeof obj.name === 'string') {
            const argsRaw = obj.args ?? obj.arguments ?? {}
            return {
                type: 'function',
                id: typeof obj.id === 'string' ? obj.id : undefined,
                function: {
                    name: obj.name,
                    arguments:
                        typeof argsRaw === 'string'
                            ? parseToolArguments(argsRaw)
                            : (argsRaw as Record<string, unknown>),
                },
            }
        }
        return null
    }
}
