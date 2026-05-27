// Recipe-based normalizer using a YAML rule pipeline. Mirrors the legacy
// `normalizeMessage` / `normalizeMessages` surface.

import { CompatMessage } from '../../types'
import { AVAILABLE_TOOLS_ROLE } from '../../utils'
import { RecipePipeline } from './pipeline'
import { loadProviders } from './providers/registry'

export class RecipeNormalizer {
    private readonly pipeline: RecipePipeline

    constructor() {
        this.pipeline = new RecipePipeline(loadProviders())
    }

    normalizeMessage(input: unknown, defaultRole: string): CompatMessage[] {
        const result = this.pipeline.run(input, defaultRole)
        if (result === undefined) {
            // cajole.yaml's catch-all matches anything; an undefined here means
            // the recipe set has a coverage gap — surface it loudly.
            throw new Error(
                `RecipeNormalizer: no recipe matched ${JSON.stringify(input)?.slice(0, 200)} — cajole.yaml should be the final catch-all`
            )
        }
        return result
    }

    normalizeMessages(input: unknown, defaultRole: string, tools?: unknown): CompatMessage[] {
        const messages: CompatMessage[] = []
        if (tools) {
            // `tools` is a separate parameter (not a message shape), so it stays
            // in code rather than being a recipe.
            messages.push({ role: AVAILABLE_TOOLS_ROLE, content: '', tools })
        }
        messages.push(...this.normalizeMessage(input, defaultRole))
        return messages
    }
}
