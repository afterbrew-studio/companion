import { defineManifest } from '@moxxy/companion-sdk';

/**
 * module-notify: outbound delivery of the inbox. Companion raises every
 * human-relevant event through `ctx.notify.emit`; this module forwards those
 * entries to somewhere people actually look (Slack, Discord, ntfy, or a generic
 * signed webhook).
 *
 * It subscribes to the `notification.raised` bus event rather than depending on
 * each producer, so a module that starts raising notifications tomorrow is
 * delivered without touching this one. Nothing here can fail the operation that
 * raised the notification: the inbox entry is already durable before delivery
 * is attempted.
 */
export default defineManifest({
  id: 'notify',
  title: 'Outbound Notifications',
  version: '0.1.0',
  dependsOn: ['core', 'workspace', 'integrations'],
  required: false,
  // Enabling delivery registers safe provider descriptors only. Nothing leaves
  // the instance until an operator deliberately creates a connection.
  autoInstall: true,
  permissions: ['notify:read'],
  messages: ['notify.changed'],
});
