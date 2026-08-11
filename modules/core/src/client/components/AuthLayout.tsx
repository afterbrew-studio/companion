import type { ReactNode } from 'react';
import { Avatar, BrandTile } from '@moxxy/companion-ui';
import { useAuth } from '../lib/auth.js';

/**
 * Shared scaffold for the signed-out screens (login, first-boot setup):
 * centered column, brand tile, heading, the page's card form, dim footnote.
 * `className` replaces the default width so Setup can go wider (SearchInput-style).
 */
export function AuthLayout({
  title,
  subtitle,
  footer,
  children,
  className = 'max-w-sm',
}: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  const { branding, version } = useAuth();
  const custom = branding.name?.trim();
  const brandName = custom || 'Companion';

  return (
    <main className="flex h-full items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className={`w-full ${className}`}>
        <div className="mb-6 text-center">
          {branding.logo || custom ? (
            <Avatar name={brandName} src={branding.logo ?? undefined} size="xl" brand className="mx-auto mb-3" />
          ) : (
            <BrandTile className="mx-auto mb-3 size-11 rounded-xl" />
          )}
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? <p className="dim mt-1">{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <p className="dim mt-4 text-center text-xs">{footer}</p> : null}
        {version ? <p className="dim mt-3 text-center text-[10px] tabular-nums">Companion v{version}</p> : null}
      </div>
    </main>
  );
}
