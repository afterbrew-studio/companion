# @moxxy/companion-ui

Internal package of [Companion](https://github.com/moxxy-ai/companion). The React components the host shell is built from: pages, headers, tables, empty states, dialogs and form controls.

**Do not import this directly.** Module authors get the same components from [`@moxxy/companion-sdk/ui`](https://www.npmjs.com/package/@moxxy/companion-sdk), which is the supported surface and keeps a module rendering with the host's React instance rather than a second copy. `companion module verify` refuses a module that reaches past the SDK into this package.

Nothing in this package follows semver for outside callers.

## License

MIT
