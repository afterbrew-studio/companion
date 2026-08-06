// Import dependency contracts so their open registries are visible here.
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import type { IntegrationsService } from '../api/integrations-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'integrations:read': true;
    'integrations:manage': true;
    'integrations:use': true;
    'integrations:self': true;
  }
  interface ServerMessageRegistry {
    'integrations.changed': Record<never, never>;
  }
  interface ServiceMap {
    integrations: IntegrationsService;
  }
}

/** Shared DTOs are aliases of the public SDK integration ABI. Keeping this
 * barrel preserves the ordinary module-contract import used by the SPA. */
export type {
  EffectiveIntegrationRoute,
  IntegrationCapability,
  IntegrationCatalog,
  IntegrationCategory,
  IntegrationConfigField,
  IntegrationConnectionDraft,
  IntegrationConnectionRecord,
  IntegrationFieldOption,
  IntegrationFieldValue,
  IntegrationHealth,
  IntegrationHealthStatus,
  IntegrationProviderDescriptor,
  IntegrationRouteRecord,
  IntegrationScope,
  IntegrationTargetRef,
} from '@moxxy/companion-sdk/server';
