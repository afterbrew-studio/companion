import { useEffect, useState } from 'react';
import { RunsPage } from './pages/RunsPage.js';
import { RunDetail } from './pages/RunDetail.js';

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/runs');
  useEffect(() => {
    const onChange = (): void => setHash(location.hash || '#/runs');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App(): JSX.Element {
  const hash = useHashRoute();
  const runMatch = hash.match(/^#\/runs\/([A-Za-z0-9_-]+)$/);
  if (runMatch) return <RunDetail key={runMatch[1]} runId={runMatch[1]!} />;
  return <RunsPage />;
}
