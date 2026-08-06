export {
  RUNTIME_CAPABILITIES,
  RUNTIME_HARNESS_ID,
  RuntimeHarness,
  readRuntimeRunHistory,
  type RuntimeHarnessHandlers,
  type RuntimeHarnessOptions,
} from './harness.js';
export {
  BUILTIN_PROVIDER_KINDS,
  DEFAULT_LIMITS,
  type ProviderKind,
  type ResolvedModelSpec,
  type RuntimeAccess,
  type RuntimeLimits,
} from './spec.js';
export { takeLines, type RuntimeCommand, type RuntimeFrame } from './protocol.js';

/**
 * The provider-plugin seam is deliberately NOT re-exported here. Its type
 * mentions the SDK's `LanguageModel`, which would drag the whole AI SDK into
 * the type graph of every consumer of this entry point, including the daemon
 * modules that only need to spawn a run. Plugins import `./plugin` instead.
 */
export { probeModel, type ProbeOutcome } from './probe.js';
