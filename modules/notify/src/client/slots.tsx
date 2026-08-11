import { defineSlots } from '@moxxy/companion-sdk/client';
import { DiscordMark, NtfyMark, SlackMark, WebhookMark } from './provider-icons.js';

function NotificationDeliveryLink(): React.JSX.Element {
  return <a className="btn-ghost" href="#/notify">Delivery history</a>;
}

export const slots = defineSlots([
  {
    slot: 'integrations.page.actions',
    key: 'notification-delivery-history',
    order: 20,
    permission: 'notify:read',
    component: NotificationDeliveryLink,
  },
  { slot: 'integrations.provider.slack.webhook.icon', key: 'slack-mark', component: SlackMark },
  { slot: 'integrations.provider.discord.webhook.icon', key: 'discord-mark', component: DiscordMark },
  { slot: 'integrations.provider.ntfy.http.icon', key: 'ntfy-mark', component: NtfyMark },
  { slot: 'integrations.provider.webhook.generic.icon', key: 'webhook-mark', component: WebhookMark },
]);
