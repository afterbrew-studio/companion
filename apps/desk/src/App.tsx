import { Component, type ErrorInfo, type ReactNode } from 'react';
import { PageLoading } from '@moxxy/companion-ui';
import { AuthProvider, LoginPage, SetupPage, useAuth } from '@companion/module-core/client';
import { DeskRoot } from '@companion/module-desk/client';
import { WorkspaceProvider } from '@companion/module-workspace/client';

export function App(): React.JSX.Element {
  return (
    <DeskErrorBoundary>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </DeskErrorBoundary>
  );
}

function Gate(): React.JSX.Element {
  const { user, needsSetup } = useAuth();
  if (user === undefined) return <PageLoading />;
  if (needsSetup) return <SetupPage />;
  if (user === null) return <LoginPage />;
  return (
    <WorkspaceProvider>
      <DeskRoot />
    </WorkspaceProvider>
  );
}

class DeskErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: Error | null }> {
  state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Companion Desk crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex h-full items-center justify-center bg-white px-6 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <div className="max-w-lg rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
          <h1 className="text-lg font-semibold">Desk could not render</h1>
          <p className="dim mt-2 text-sm">{this.state.error.message}</p>
          <button type="button" className="btn mt-4" onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    );
  }
}
