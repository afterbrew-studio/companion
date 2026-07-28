# @moxxy/companion-types

Internal package of [Companion](https://github.com/moxxy-ai/companion). Shared type definitions used across the host, the runner and the modules.

**Do not import this directly.** It is published so TypeScript can resolve the declarations behind [`@moxxy/companion-sdk`](https://www.npmjs.com/package/@moxxy/companion-sdk), which re-exports the types a module is meant to use. `companion module verify` refuses a module that reaches past the SDK into this package.

Nothing in this package follows semver for outside callers.

## License

MIT
