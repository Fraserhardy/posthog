// Loads `./yaml/*.yaml` providers, compiles each into the IR, returns the
// dispatch-ordered list. Priority numbers in the YAML files match the order
// here so divergence with the legacy if/else chain stays auditable.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Provider } from '../ir'
import { compileProvider } from '../yaml/compiler'
import { parseYaml } from '../yaml/parser'

const YAML_DIR = path.join(__dirname, 'yaml')

const PROVIDER_FILES = [
    'dispatcher_entry.yaml',
    'compat_array.yaml',
    'litellm.yaml',
    'langchain_envelope.yaml',
    'vercel_sdk.yaml',
    'openai_chat.yaml',
    'openai_responses.yaml',
    'anthropic.yaml',
    'otel.yaml',
    'langchain.yaml',
    'wrappers.yaml',
    'cajole.yaml',
] as const

const PROVIDERS: Provider[] = PROVIDER_FILES.map((file) => {
    const raw = readFileSync(path.join(YAML_DIR, file), 'utf8')
    try {
        return compileProvider(parseYaml(raw))
    } catch (err) {
        throw new Error(`Loading provider ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
})

export function loadProviders(): Provider[] {
    return PROVIDERS
}
