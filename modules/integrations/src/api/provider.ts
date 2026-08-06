/**
 * Short in-tree barrel for provider consumers. The ABI itself remains public
 * SDK surface so an out-of-tree integration never has to import this private
 * workspace package at runtime.
 */
export { IntegrationUnavailableError, NOTIFICATION_KIND_OPTIONS } from '@moxxy/companion-sdk/server';
export type {
  IntegrationConnectionAccess,
  IntegrationDeliveryResult,
  IntegrationHost,
  IntegrationNotificationInput,
  IntegrationProviderAdapter,
  IntegrationReviewFinding,
  IntegrationReviewRequest,
  IntegrationReviewResult,
  ResolvedIntegrationTarget,
} from '@moxxy/companion-sdk/server';
