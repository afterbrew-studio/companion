// module-oidc adds no DTOs and no permissions: the sign-in flow is two public
// routes and everything after it belongs to module-core. This import is what
// makes core's ServiceMap augmentation (`core: Auth`) visible here, so
// `ctx.services.get('core')` type-checks. Types are erased at runtime.
import '@companion/module-core/contract';

export {};
