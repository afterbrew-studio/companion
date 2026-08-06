import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderKind, ResolvedModelSpec } from '../spec.js';

export type ProviderFactory = (spec: ResolvedModelSpec) => LanguageModel;

/**
 * The ONE place in this runtime that names a vendor, and it is a lookup rather
 * than a branch. Everything else about a provider is data on the spec, which is
 * what lets an operator point Companion at their own gateway, their own Azure
 * resource or their own vLLM box without waiting for a release.
 *
 * `openai-compatible` is the escape hatch that keeps this table from having to
 * grow with the market. `azure` is here because the deployment name lives in
 * the URL path and the API is versioned by query parameter, so routing it
 * through the generic kind produces a record that works for exactly one model.
 */
const FACTORIES: Record<string, ProviderFactory> = {
  anthropic: (spec) =>
    createAnthropic({
      ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
      headers: { ...spec.headers },
    })(spec.model),

  openai: (spec) =>
    createOpenAI({
      ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
      headers: { ...spec.headers },
    })(spec.model),

  azure: (spec) =>
    createAzure({
      ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
      ...(spec.apiVersion ? { apiVersion: spec.apiVersion } : {}),
      ...(spec.factoryOptions.useDeploymentBasedUrls === true ? { useDeploymentBasedUrls: true } : {}),
      headers: { ...spec.headers },
    })(spec.model),

  'openai-compatible': (spec) =>
    createOpenAICompatible({
      name: spec.providerId,
      baseURL: spec.baseUrl ?? '',
      ...(spec.apiKey ? { apiKey: spec.apiKey } : {}),
      headers: { ...spec.headers },
      queryParams: { ...spec.query },
    })(spec.model),
};

const plugins = new Map<string, ProviderFactory>();

/**
 * A provider this build does not carry, contributed by a plugin the operator
 * dropped in. Registered before the first turn, so a plugin that fails to load
 * fails the run rather than silently falling through to another vendor.
 */
export function registerProviderFactory(kind: string, factory: ProviderFactory): void {
  plugins.set(kind, factory);
}

export function resolveModel(spec: ResolvedModelSpec): LanguageModel {
  const factory = plugins.get(spec.kind) ?? FACTORIES[spec.kind];
  if (!factory) throw new Error(`no provider factory for kind '${spec.kind}'`);
  return factory(spec);
}

export function knownProviderKinds(): readonly ProviderKind[] {
  return [...Object.keys(FACTORIES), ...plugins.keys()];
}
