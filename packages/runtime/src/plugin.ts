/**
 * What a provider plugin imports. Kept out of the main entry point on purpose:
 * `ProviderFactory` mentions the SDK's `LanguageModel`, and re-exporting it
 * would put the whole AI SDK in the type graph of every daemon module that only
 * needs to start a run.
 */
export { registerProviderFactory, knownProviderKinds, type ProviderFactory } from './child/providers.js';
export type { ProviderKind, ResolvedModelSpec } from './spec.js';
