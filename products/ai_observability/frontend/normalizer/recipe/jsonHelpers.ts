// JSON-shaped helpers duplicated from `../../utils` privates to avoid adding
// new exports there for the recipe port. Collapse when the recipe code is
// the only path.

import { MultiModalContentItem } from '../../types'

const STRUCTURED_CONTENT_TYPES = new Set([
    'text',
    'output_text',
    'input_text',
    'function',
    'image',
    'input_image',
    'image_url',
    'file',
    'audio',
    'document',
])

export function parseToolArgumentsLocal(
    args: string | Record<string, unknown> | unknown
): Record<string, unknown> | string {
    if (typeof args === 'string') {
        try {
            return JSON.parse(args)
        } catch {
            return args
        }
    }
    if (args && typeof args === 'object') {
        return args as Record<string, unknown>
    }
    return {}
}

export function parseStringifiedStructuredContentLocal(content: string): string | MultiModalContentItem[] {
    const trimmed = content.trim()
    if (!trimmed.startsWith('[')) {
        return content
    }
    try {
        const parsed = JSON.parse(trimmed)
        if (
            Array.isArray(parsed) &&
            (parsed.length === 0 ||
                parsed.every(
                    (item) =>
                        item &&
                        typeof item === 'object' &&
                        'type' in item &&
                        typeof item.type === 'string' &&
                        STRUCTURED_CONTENT_TYPES.has(item.type)
                ))
        ) {
            return parsed as MultiModalContentItem[]
        }
    } catch {
        // Not valid JSON — keep the raw string.
    }
    return content
}
