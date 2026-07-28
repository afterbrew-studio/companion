# @moxxy/companion-core

Internal package of [Companion](https://github.com/moxxy-ai/companion). The kernel: the module registry, the config and secret stores, migrations, and the ABI bridge that hands loaded modules the host's live namespace.

**Do not import this directly.** It is published so TypeScript can resolve the declarations behind [`@moxxy/companion-sdk`](https://www.npmjs.com/package/@moxxy/companion-sdk), which is the supported surface for module authors. `companion module verify` refuses a module that reaches past the SDK into this package, and the runtime bridge only ever resolves the SDK specifier, so an import here is a build that cannot load.

Nothing in this package follows semver for outside callers. It changes whenever the kernel changes.

## License

MIT
