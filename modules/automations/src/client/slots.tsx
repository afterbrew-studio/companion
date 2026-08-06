import { useState } from 'react';
import { defineSlots, useIntent } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { AssistantButton, AssistantPanel } from './components/Assistant.js';

/**
 * AI Help, contributed to the shell's top bar. Button and panel ship as ONE
 * contribution because they share open/closed state: splitting them across two
 * slots would push that state back into the shell, which is exactly what this
 * module is being lifted out of.
 */
function Assistant(): JSX.Element {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  // Mounted on first open and kept alive afterwards, so the conversation and
  // the exit slide survive closing the panel.
  const [mounted, setMounted] = useState(false);
  const openPanel = (): void => {
    if (mounted) {
      setOpen(true);
      return;
    }
    setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
  };
  useIntent('ask-ai', openPanel);
  const toggle = (): void => {
    if (mounted) return setOpen((o) => !o);
    // Mount closed, open a frame later, so the FIRST open animates too.
    openPanel();
  };

  // Starting or resuming the conversation is an agent action. A read-only
  // custom role should not get a button that can only fail after opening.
  if (!can('runs:read') || !can('runs:act')) return <></>;
  return (
    <>
      <AssistantButton open={open} onClick={toggle} />
      {mounted ? <AssistantPanel open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export const slots = defineSlots([
  {
    slot: 'shell.topbar',
    key: 'automations-assistant',
    order: 40,
    permission: 'runs:act',
    component: Assistant,
  },
]);
