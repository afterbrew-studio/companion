/**
 * `@moxxy-ai/companion-sdk/ui` — the component library module pages render with.
 *
 * Re-exported wholesale, unlike the other entry points. `@companion/ui` is a
 * leaf with no host machinery in it: every export is a component, an icon or a
 * presentation hook, so there is nothing to curate away. Keeping it a wildcard
 * also means a new shared component is available to modules the moment it lands,
 * which is the behaviour you want from a design system.
 *
 * Source-only, for the same reason as `/client`.
 */
export * from '@companion/ui';
