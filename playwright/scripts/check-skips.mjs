#!/usr/bin/env node
// Fails when a Playwright `test.skip(` or `test.fixme(` lacks a
// `// Tracked: <url>` comment within 3 lines above. See SKIP_TRIAGE.md.
//
// Run locally:        node playwright/scripts/check-skips.mjs
// Warn-only mode:     CHECK_SKIPS_WARN_ONLY=1 node playwright/scripts/check-skips.mjs

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP_PATTERN = /^\s*(test|it)\.(skip|fixme)\(/
const TRACKED_PATTERN = /^\s*\/\/\s*Tracked:\s*\S+/i
const LOOKBACK_LINES = 3

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const E2E_DIR = join(SCRIPT_DIR, '..', 'e2e')

async function* walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
            yield* walk(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
            yield fullPath
        }
    }
}

const offenders = []

for await (const file of walk(E2E_DIR)) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    for (let i = 0; i < lines.length; i++) {
        if (!SKIP_PATTERN.test(lines[i])) {
            continue
        }
        const start = Math.max(0, i - LOOKBACK_LINES)
        const hasTrackedComment = lines.slice(start, i).some((l) => TRACKED_PATTERN.test(l))
        if (!hasTrackedComment) {
            offenders.push({
                file: relative(join(SCRIPT_DIR, '..', '..'), file),
                line: i + 1,
                text: lines[i].trim(),
            })
        }
    }
}

if (offenders.length === 0) {
    console.log('\u2713 No untracked test.skip / test.fixme calls.')
    process.exit(0)
}

console.error(`Found ${offenders.length} untracked test.skip / test.fixme call(s):\n`)
for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.text}`)
}
console.error(
    `\nEach skipped test must have a "// Tracked: <ticket url>" comment within ${LOOKBACK_LINES} lines above it.`
)
console.error('See playwright/SKIP_TRIAGE.md for the un-skip workflow.')

if (process.env.CHECK_SKIPS_WARN_ONLY === '1') {
    console.error('\n(warn-only mode — exiting 0)')
    process.exit(0)
}
process.exit(1)
