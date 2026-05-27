// Escape hatch for cases that don't fit a structural DSL primitive.
// Today: just the OpenAI Responses built-in tool-call `arguments` branch.

import { parseToolArgumentsLocal as parseToolArguments } from './jsonHelpers'

export type HelperFn = (input: unknown) => unknown

function openaiResponsesBuiltinArgs(toolCall: unknown): Record<string, unknown> | string {
    if (!toolCall || typeof toolCall !== 'object') {
        return {}
    }
    const obj = toolCall as Record<string, unknown>
    if ('arguments' in obj && obj.arguments !== undefined && obj.arguments !== null) {
        const args = obj.arguments
        if (typeof args === 'string' || (typeof args === 'object' && !Array.isArray(args))) {
            return parseToolArguments(args as string | Record<string, unknown>)
        }
        // Non-object, non-string args (e.g. number, array) — wrap so the
        // value still surfaces in the rendered tool call.
        return { arguments: args }
    }
    // No `arguments` field — fall back to "everything except the structural
    // fields" so the user sees whatever the SDK actually sent.
    const { id: _id, type: _type, status: _status, name: _name, arguments: _args, ...rest } = obj
    return rest
}

export const HELPERS: Record<string, HelperFn> = {
    openai_responses_builtin_args: openaiResponsesBuiltinArgs,
}
