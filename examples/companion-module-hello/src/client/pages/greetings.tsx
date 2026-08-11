import { useState } from 'react';
import { ErrorBar, Field, Page, PageHeader } from '@moxxy/companion-sdk/ui';
import type { GreetingResponse } from '../../contract/index.js';
import { greetingsApi } from '../api.js';

export function GreetingsPage(): React.JSX.Element {
  const [name, setName] = useState('');
  const [result, setResult] = useState<GreetingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const greet = async (): Promise<void> => {
    setBusy(true);
    try {
      setResult(await greetingsApi.greet(name));
      setError(null);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Hello World"
        subtitle="The smallest out-of-tree module: one permission, one route, one table, one page"
      />
      <ErrorBar error={error} />
      <form
        className="flex max-w-md items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void greet();
        }}
      >
        <Field label="Your name" className="flex-1">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada" />
        </Field>
        <button className="btn" type="submit" disabled={busy || !name.trim()}>
          Greet
        </button>
      </form>
      {result ? (
        <p className="text-sm">
          {result.message} This instance has recorded {result.total} greeting{result.total === 1 ? '' : 's'}.
        </p>
      ) : null}
    </Page>
  );
}
