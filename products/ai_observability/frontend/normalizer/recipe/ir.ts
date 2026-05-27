// Internal representation for recipes. YAML files compile into these shapes;
// the runtime never sees raw YAML.

export type ProviderKind = 'chat' | 'structured'

export interface Provider {
    id: string
    kind: ProviderKind
    priority: number
    rules: Rule[]
    // Fires once per match. Currently only PostHog `capture:` — used by cajole
    // to preserve the "we failed to normalize this" telemetry.
    capture?: string
}

export interface Rule {
    on: Pattern
    emit?: EmitSpec // produce one CompatMessage
    delegate?: ValueExpr // re-dispatch a sub-payload, return its output unchanged
    delegateEach?: ValueExpr // iterate array, dispatch each, concat
    // Only meaningful with delegateEach: merges these fields onto every produced
    // message. The Anthropic tool_result pattern — children normalize independently
    // and the parent stamps role / tool_call_id afterward.
    stamp?: EmitSpec
    // Extra messages produced after the primary. Either static (one literal
    // EmitSpec) or list expansion (every element of a runtime array becomes its
    // own followup). Used for Anthropic role-based + top-level tool_calls and
    // OTel `tool_call_response` splitting.
    followups?: FollowupSpec[]
}

export type FollowupSpec = { kind: 'static'; emit: EmitSpec } | { kind: 'expand'; from: ValueExpr; each: EmitSpec }

export type Pattern = Record<string, FieldPredicate>

export type FieldPredicate =
    | { kind: 'equals'; value: unknown }
    | { kind: 'exists'; present: boolean }
    | { kind: 'is'; types: TypeName[] }
    | { kind: 'in'; values: unknown[] }
    | { kind: 'shape'; nested: Pattern }
    | { kind: 'every'; element: FieldPredicate } // all array elements must match

export type TypeName = 'string' | 'array' | 'object' | 'null' | 'number' | 'boolean' | 'any'

export type ValueExpr =
    | { tag: 'literal'; value: unknown }
    | { tag: 'path'; segments: string[] }
    | { tag: 'self' }
    | { tag: 'interp'; parts: (string | ValueExpr)[] }
    | { tag: 'object'; fields: Record<string, ValueExpr> }
    | { tag: 'array'; items: ValueExpr[] }
    | { tag: 'op'; op: string; args: Record<string, ValueExpr | unknown> }

export interface EmitSpec {
    role?: ValueExpr | RoleTag
    content?: ValueExpr
    toolCall?: ValueExpr
    toolCalls?: ValueExpr
    toolCallId?: ValueExpr
    spread?: ValueExpr
}

export type RoleTag = 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'tool_result'
