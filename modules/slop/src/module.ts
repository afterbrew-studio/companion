import { defineManifest } from '@moxxy/companion-sdk';

/**
 * module-slop — Contribution Quality: a one-shot agent assesses a pull request
 * against the workspace's detection rules (built-in + user-defined) and
 * proposes an action (label / comment / request changes / close). Review-
 * then-apply: nothing touches GitHub until a human applies the verdict.
 */
export default defineManifest({
  id: 'slop',
  title: 'Contribution quality',
  version: '0.1.0',
  // Hard deps: PRs come from code's sync cache and actions go through its
  // GitHub client registry; the detection agent runs through operate; rules
  // and detections scope through workspaces.
  dependsOn: ['core', 'workspace', 'code', 'operate'],
  required: false,
  permissions: ['slop:read', 'slop:act', 'slop:manage'],
  // Soft: a detection offers "send to refinement" only when refinement is
  // enabled and the viewer may manage it. The button hides otherwise.
  consumes: ['refine:manage'],
  messages: ['slop.changed'],
  config: [
    {
      key: 'label',
      label: 'Quality-review label',
      kind: 'text',
      default: 'needs-evidence',
      max: 50,
      placeholder: 'needs-evidence',
    },
  ],
});
