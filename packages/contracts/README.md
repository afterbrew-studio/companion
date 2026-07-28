# @moxxy/companion-contracts

The augmentation target for [Companion](https://github.com/moxxy-ai/companion) modules.

Companion's permissions, server messages, services and bus events are open registries: a module adds its own keys by declaration merging rather than by editing a central union. This package holds those interfaces, and it exists as its own package for one reason.

TypeScript binds a merged declaration to the module that **declares** the interface. Augmenting a package that merely re-exports it produces a second, unrelated interface, and the new keys never reach the host. So the declaration site has to be a stable, directly importable specifier, and that is this package.

```ts
declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'reports:read': true;
  }
  interface ServerMessageRegistry {
    'reports:changed': { workspaceId: string };
  }
}
```

Install it alongside the SDK, which lists it as a peer dependency:

```sh
npm install @moxxy/companion-sdk @moxxy/companion-contracts
```

Everything else a module needs comes from [`@moxxy/companion-sdk`](https://www.npmjs.com/package/@moxxy/companion-sdk). This package is only the merge point.

## License

MIT
