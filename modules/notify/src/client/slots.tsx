import { defineSlots } from '@moxxy/companion-sdk/client';

function NotificationDeliveryLink(): JSX.Element {
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
]);
