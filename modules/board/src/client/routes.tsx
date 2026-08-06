import { RequiresRepo } from '@companion/module-code/client';
import { defineClientRoutes, lazyView, type RouteProps } from '@moxxy/companion-sdk/client';

const BoardPage = lazyView(async () => {
  const { default: Board } = await import('./pages/Board.js');
  const GatedBoard = (props: RouteProps): JSX.Element => (
    <RequiresRepo what="Task Board">
      <Board {...props} />
    </RequiresRepo>
  );
  return { default: GatedBoard };
});

export const routes = defineClientRoutes([
  { match: { exact: '/board' }, permission: 'board:read', component: BoardPage },
]);
