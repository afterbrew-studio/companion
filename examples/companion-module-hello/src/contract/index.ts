/**
 * Registry augmentation targets `@moxxy/companion-contracts`, never the SDK:
 * TypeScript binds declaration merging to the package that declares the
 * interface, and augmenting a re-export would silently create a second,
 * unrelated registry. This file carries types only; it compiles to nothing.
 */
declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'hello:greet': true;
  }
}

/** What the greeting route returns. */
export interface GreetingResponse {
  readonly message: string;
  /** How many greetings this instance has recorded, including this one. */
  readonly total: number;
}
