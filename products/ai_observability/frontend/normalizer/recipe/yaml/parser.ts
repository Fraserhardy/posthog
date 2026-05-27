// Minimal YAML parser for the recipe DSL — hand-rolled to avoid pulling
// `js-yaml` from the registry. Supports the subset our recipes use:
// block + flow mappings/sequences, quoted/unquoted scalars, `#` comments.
// Does NOT support: anchors, tags, multi-line scalars (`|`/`>`), `---`
// streams, complex keys. Swap in `js-yaml` if needed (see TRADEOFFS.md).

export function parseYaml(source: string): unknown {
    const lines = preprocess(source)
    if (lines.length === 0) {
        return null
    }
    const [value, _consumed] = parseBlockNode(lines, 0, -1)
    return value
}

interface Line {
    raw: string
    indent: number
    content: string
    lineNumber: number
}

function preprocess(source: string): Line[] {
    const out: Line[] = []
    source.split('\n').forEach((raw, i) => {
        const noComment = stripComment(raw)
        if (noComment.trim().length === 0) {
            return
        }
        const indent = noComment.length - noComment.replace(/^[ \t]+/, '').length
        out.push({ raw, indent, content: noComment.trim(), lineNumber: i + 1 })
    })
    return out
}

function stripComment(line: string): string {
    // Strip `# ...` to end of line, but only when not inside quotes.
    let inSingle = false
    let inDouble = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle
        } else if (ch === '"' && !inSingle) {
            inDouble = !inDouble
        } else if (ch === '#' && !inSingle && !inDouble) {
            // Require whitespace before # so URL-like values stay intact.
            if (i === 0 || /\s/.test(line[i - 1])) {
                return line.slice(0, i).replace(/\s+$/, '')
            }
        }
    }
    return line
}

// Parses a block node starting at `start`, where any line in this node has
// indent strictly greater than `parentIndent`. Returns the parsed value plus
// the index of the next unconsumed line.
function parseBlockNode(lines: Line[], start: number, parentIndent: number): [unknown, number] {
    if (start >= lines.length) {
        return [null, start]
    }
    const firstIndent = lines[start].indent
    if (firstIndent <= parentIndent) {
        return [null, start]
    }
    // Sequence: lines starting with `- `
    if (lines[start].content.startsWith('-')) {
        return parseBlockSequence(lines, start, firstIndent)
    }
    // Mapping
    return parseBlockMapping(lines, start, firstIndent)
}

function parseBlockSequence(lines: Line[], start: number, indent: number): [unknown[], number] {
    const out: unknown[] = []
    let i = start
    while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith('-')) {
        const dashContent = lines[i].content.slice(1).trim()
        if (dashContent === '') {
            // Block-style nested node on following lines
            const [value, next] = parseBlockNode(lines, i + 1, indent)
            out.push(value)
            i = next
        } else if (looksLikeKey(dashContent) && !isFlow(dashContent)) {
            // `- key: ...` — a mapping that starts on the dash line. YAML
            // treats this as if there were a hidden indent at the column of
            // the first key (dash + space + key offset).
            const dashIndent = indent + 2
            const inlineMapping: Record<string, unknown> = {}
            const { key, rest } = splitKey(dashContent)
            if (rest === '') {
                // Value of this key lives in the block below.
                const [value, next] = parseBlockNode(lines, i + 1, dashIndent)
                inlineMapping[key] = value
                i = next
            } else {
                inlineMapping[key] = parseScalarOrFlow(rest)
                i += 1
            }
            // Continue absorbing sibling keys at dashIndent (the column of
            // the first key on the dash line).
            while (i < lines.length && lines[i].indent === dashIndent && !lines[i].content.startsWith('-')) {
                i = consumeMappingLine(lines, i, dashIndent, inlineMapping)
            }
            out.push(inlineMapping)
        } else {
            // Scalar after dash, or flow form
            out.push(parseScalarOrFlow(dashContent))
            i += 1
        }
    }
    return [out, i]
}

function looksLikeKey(content: string): boolean {
    // Reuse splitKey: if it finds a colon-at-end-or-followed-by-space we
    // call the content a mapping starter.
    const { rest, key } = splitKey(content)
    // splitKey returns rest='' when no separator was found AND when the
    // separator was found but value was empty. Distinguish by checking the
    // raw string: a key-like line contains `:` followed by whitespace or EOL.
    if (!content.includes(':')) {
        return false
    }
    // If splitKey didn't consume anything (key === content && rest === ''),
    // there was no key separator → not a key line.
    return !(key === content && rest === '')
}

function parseBlockMapping(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
    const out: Record<string, unknown> = {}
    let i = start
    while (i < lines.length && lines[i].indent === indent && !lines[i].content.startsWith('-')) {
        i = consumeMappingLine(lines, i, indent, out)
    }
    return [out, i]
}

// Consume one `key:` or `key: value` line. May descend into a nested block
// node if the line ends bare. Returns the next line index.
function consumeMappingLine(lines: Line[], i: number, indent: number, out: Record<string, unknown>): number {
    const { key, rest } = splitKey(lines[i].content)
    if (rest === '') {
        const [value, next] = parseBlockNode(lines, i + 1, indent)
        out[key] = value
        return next
    }
    out[key] = parseScalarOrFlow(rest)
    return i + 1
}

function splitKey(content: string): { key: string; rest: string } {
    // Find the first colon that's NOT inside quotes or a flow collection.
    let depth = 0
    let inSingle = false
    let inDouble = false
    for (let i = 0; i < content.length; i++) {
        const ch = content[i]
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle
        } else if (ch === '"' && !inSingle) {
            inDouble = !inDouble
        } else if (!inSingle && !inDouble) {
            if (ch === '{' || ch === '[') {
                depth++
            } else if (ch === '}' || ch === ']') {
                depth--
            } else if (ch === ':' && depth === 0 && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
                const key = content.slice(0, i).trim()
                const rest = content.slice(i + 1).trim()
                return { key: unquote(key), rest }
            }
        }
    }
    return { key: unquote(content.trim()), rest: '' }
}

function isFlow(content: string): boolean {
    const first = content.trim()[0]
    return first === '{' || first === '['
}

function parseScalarOrFlow(s: string): unknown {
    const trimmed = s.trim()
    if (trimmed === '') {
        return null
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return parseFlow(trimmed)[0]
    }
    return parseScalar(trimmed)
}

function parseScalar(s: string): unknown {
    if (s.length === 0) {
        return null
    }
    if (s === 'null' || s === '~') {
        return null
    }
    if (s === 'true') {
        return true
    }
    if (s === 'false') {
        return false
    }
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
        return s.slice(1, -1).replace(/''/g, "'")
    }
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
        return JSON.parse(s)
    }
    if (/^-?\d+$/.test(s)) {
        return parseInt(s, 10)
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
        return parseFloat(s)
    }
    return s
}

function unquote(s: string): string {
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
        return s.slice(1, -1)
    }
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
        return JSON.parse(s)
    }
    return s
}

// --- Flow style (inline JSON-ish) ----------------------------------------

function parseFlow(s: string): [unknown, number] {
    let pos = 0
    skipWhitespace()

    function skipWhitespace(): void {
        while (pos < s.length && /\s/.test(s[pos])) {
            pos++
        }
    }

    function parseValue(): unknown {
        skipWhitespace()
        const ch = s[pos]
        if (ch === '{') {
            return parseFlowMap()
        }
        if (ch === '[') {
            return parseFlowSeq()
        }
        if (ch === '"' || ch === "'") {
            return parseQuoted()
        }
        return parseFlowScalar()
    }

    function parseFlowMap(): Record<string, unknown> {
        pos++ // consume '{'
        const out: Record<string, unknown> = {}
        skipWhitespace()
        if (s[pos] === '}') {
            pos++
            return out
        }
        while (pos < s.length) {
            skipWhitespace()
            const key = String(parseValue())
            skipWhitespace()
            if (s[pos] !== ':') {
                throw new Error(`Expected ':' in flow mapping at ${pos}: ${s.slice(pos, pos + 30)}`)
            }
            pos++
            out[key] = parseValue()
            skipWhitespace()
            if (s[pos] === ',') {
                pos++
                continue
            }
            if (s[pos] === '}') {
                pos++
                return out
            }
            throw new Error(`Unexpected '${s[pos]}' in flow mapping at ${pos}`)
        }
        throw new Error('Unterminated flow mapping')
    }

    function parseFlowSeq(): unknown[] {
        pos++ // consume '['
        const out: unknown[] = []
        skipWhitespace()
        if (s[pos] === ']') {
            pos++
            return out
        }
        while (pos < s.length) {
            out.push(parseValue())
            skipWhitespace()
            if (s[pos] === ',') {
                pos++
                continue
            }
            if (s[pos] === ']') {
                pos++
                return out
            }
            throw new Error(`Unexpected '${s[pos]}' in flow sequence at ${pos}`)
        }
        throw new Error('Unterminated flow sequence')
    }

    function parseQuoted(): string {
        const quote = s[pos]
        const start = pos
        pos++
        while (pos < s.length && s[pos] !== quote) {
            if (s[pos] === '\\' && quote === '"') {
                pos += 2
            } else {
                pos++
            }
        }
        if (pos >= s.length) {
            throw new Error(`Unterminated string starting at ${start}`)
        }
        const raw = s.slice(start, pos + 1)
        pos++
        if (quote === '"') {
            return JSON.parse(raw)
        }
        return raw.slice(1, -1).replace(/''/g, "'")
    }

    function parseFlowScalar(): unknown {
        // In flow context, `:` separates key from value, so unquoted scalars
        // must stop at it. Quoted strings (handled by parseQuoted) can carry
        // colons.
        const start = pos
        while (pos < s.length && !/[,\]}\s:]/.test(s[pos])) {
            pos++
        }
        return parseScalar(s.slice(start, pos))
    }

    const value = parseValue()
    return [value, pos]
}
