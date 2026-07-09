// module-admin depends on module-core; this side-effect import carries core's
// `PermissionRegistry` augmentation (so `settings:manage` typechecks) and lets
// us reuse its identity/branding DTOs. admin owns no tables and grants no new
// capability — it is a thin management surface over core-owned settings.
import '@companion/module-core/contract';
import type { InstanceBranding, NotificationScope } from '@companion/module-core/contract';

export type { InstanceBranding, NotificationScope } from '@companion/module-core/contract';

/** Instance-wide notification defaults (admin-managed). Each user may override in their profile. */
export interface NotificationSettings {
  readonly defaultScope: NotificationScope;
}

/** PUT /api/settings/branding — name + inline logo data URL (null clears). */
export interface UpdateBrandingRequest {
  readonly name: string | null;
  readonly logo: string | null;
}

export interface UpdateBrandingResponse {
  readonly branding: InstanceBranding;
}
