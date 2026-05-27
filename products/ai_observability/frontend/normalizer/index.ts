// Public entry point for the recipe-based normalizer. The original
// `normalizeMessage` / `normalizeMessages` in `../utils` stay the only
// production code path until we decide to flip; this module is exercised by
// the test suite and is ready to be wired behind a feature flag when we
// want to start dual-running in prod.

export { RecipeNormalizer } from './recipe/normalizer'
