## Why

<!-- Describe the user or maintainer problem this change solves. -->

## What changed

<!-- Keep this focused on observable behaviour and important design decisions. -->

## Verification

<!-- List exact commands and the real flow you drove. -->

- [ ] `pnpm typecheck`
- [ ] Relevant tests/builds pass
- [ ] I exercised the changed behaviour in a real Companion instance, or explained why that is not applicable
- [ ] Cross-boundary DTOs and permissions live in the shared contract
- [ ] Mutations broadcast the matching change event
- [ ] No secret or credential can cross to the browser or logs
- [ ] User-facing behaviour and release notes/docs are updated where needed

## Screenshots

<!-- Required for visible UI changes; remove this section otherwise. -->
