import { defineSlots } from '@moxxy/companion-sdk/client';

/**
 * Cursor's mark, inline so an air-gapped instance draws it like any other pixel
 * it ships. It is Cursor's trademark, used only to identify their integration;
 * the path is their single-path mark from simple-icons (CC0). Their brand
 * colour is black, so it follows the theme instead — a black mark disappears on
 * the dark tile it sits in.
 */
function CursorMark(): React.JSX.Element {
  return (
    <svg
      className="size-5 fill-zinc-900 dark:fill-zinc-100"
      viewBox="0 0 24 24"
      role="img"
      aria-label="Cursor"
    >
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  );
}

export const slots = defineSlots([
  { slot: 'integrations.provider.cursor.bugbot.icon', key: 'cursor-mark', component: CursorMark },
]);
