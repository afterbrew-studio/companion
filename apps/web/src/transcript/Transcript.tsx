import { useEffect, useRef } from 'react';
import type { Block } from './fold.js';

export function Transcript({ blocks }: { blocks: Block[] }): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [blocks]);

  return (
    <div className="transcript">
      {blocks.map((block) => (
        <BlockView key={block.key} block={block} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function BlockView({ block }: { block: Block }): JSX.Element | null {
  switch (block.kind) {
    case 'user':
      return (
        <div className="block user">
          {block.trigger ? <div className="trigger-tag">⚡ {block.trigger}</div> : null}
          <pre>{block.text}</pre>
        </div>
      );
    case 'assistant':
      return (
        <div className={`block assistant${block.streaming ? ' streaming' : ''}`}>
          <pre>{block.text}</pre>
        </div>
      );
    case 'reasoning':
      return (
        <details className="block reasoning" open={block.streaming}>
          <summary>thinking{block.streaming ? '…' : ''}</summary>
          <pre>{block.text}</pre>
        </details>
      );
    case 'tool':
      return (
        <details className={`block tool tool-${block.status}`}>
          <summary>
            <span className={`dot ${block.status}`} /> {block.name}
            <span className="tool-status">{block.status}</span>
          </summary>
          <pre className="tool-input">{safeJson(block.input)}</pre>
          {block.detail ? <pre className="tool-detail">{block.detail}</pre> : null}
        </details>
      );
    case 'notice':
      return <div className={`block notice ${block.level}`}>{block.text}</div>;
    default:
      return null;
  }
}

function safeJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? '';
    return raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw;
  } catch {
    return String(value);
  }
}
