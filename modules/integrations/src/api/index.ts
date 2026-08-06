import { defineApiModule } from '@moxxy/companion-sdk/server';
import manifest from '../module.js';
import acl from './acl.js';
import migrations from './migrations.js';
import registerServices from './services.js';
import routes from './routes.js';

export type {
  IntegrationConnectionAccess,
  IntegrationDeliveryResult,
  IntegrationNotificationInput,
  IntegrationProviderAdapter,
  IntegrationReviewFinding,
  IntegrationReviewRequest,
  IntegrationReviewResult,
  ResolvedIntegrationTarget,
} from './provider.js';
export { IntegrationUnavailableError } from './provider.js';
export { IntegrationsService } from './integrations-service.js';

export default defineApiModule({ manifest, acl, migrations, registerServices, routes });
