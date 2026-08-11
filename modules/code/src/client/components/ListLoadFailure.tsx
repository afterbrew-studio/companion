import { EmptyState } from '@moxxy/companion-sdk/ui';

/** Turn transport-shaped errors into something a maintainer can act on. */
export function listLoadErrorMessage(noun: string, error: string): string {
  const detail = error.replace(/^(?:TypeError|Error):\s*/i, '').trim();
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return `Could not refresh ${noun}. Companion's API is unreachable.`;
  }
  return `Could not refresh ${noun}: ${detail || 'unknown error'}`;
}

/** A failed first page is not an empty list — keep the two states distinct. */
export function ListLoadFailure({
  noun,
  error,
  onRetry,
}: {
  noun: string;
  error: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <EmptyState
      title={`Could not load ${noun}`}
      hint={listLoadErrorMessage(noun, error)}
      action={
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      }
    />
  );
}
