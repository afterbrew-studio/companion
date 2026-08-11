import { defineNav, defineSections, NavIcon } from '@moxxy/companion-sdk/client';

/** A single catalog entry: an example should not claim a permanent sidebar row. */
export const sections = defineSections([{ id: 'hello', label: 'Hello World', order: 95, placement: 'catalog' }]);

export const nav = defineNav([
  {
    key: 'hello',
    label: 'Hello World',
    hash: '#/hello',
    permission: 'hello:greet',
    section: 'hello',
    order: 0,
    icon: (
      <NavIcon>
        <path d="M21 12a8 8 0 0 1-8 8H4l2.5-2.5A8 8 0 1 1 21 12z" />
        <path d="M9 12h.01M12.5 12h.01M16 12h.01" />
      </NavIcon>
    ),
  },
]);
