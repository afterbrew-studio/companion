import { generateText, tool } from 'ai';
import { z } from 'zod';
import { resolveModel } from './child/providers.js';
import type { ResolvedModelSpec } from './spec.js';

export interface ProbeOutcome {
  readonly ok: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly at: number;
  readonly detail: string | null;
}

/**
 * One real round trip against a configured model, so an operator learns what it
 * can do before a run does.
 *
 * Tool calling is the axis that matters: a model that cannot call a tool is
 * useless to this harness for anything but a prompt-only answer, and plenty of
 * endpoints advertise one that cannot. It is safe to run in the daemon because
 * the only tool is a constant and nothing here touches the filesystem.
 */
export async function probeModel(spec: ResolvedModelSpec, timeoutMs = 30_000): Promise<ProbeOutcome> {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  try {
    const result = await generateText({
      model: resolveModel(spec),
      abortSignal: aborter.signal,
      maxOutputTokens: 64,
      prompt: 'Call the ping tool with the value "ok". Do not answer in prose.',
      tools: {
        ping: tool({
          description: 'Answer with the value you were given.',
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      },
    });
    const calledTool = result.steps.some((step) => step.toolCalls.length > 0);
    return {
      ok: true,
      tools: calledTool,
      // Streaming is a property of the transport rather than the model, and
      // every provider this build carries streams. Claiming to have measured it
      // from a non-streaming call would be a fabricated observation.
      streaming: true,
      at: Date.now(),
      detail: calledTool ? null : 'The model answered but did not call the tool it was asked to call.',
    };
  } catch (err) {
    return {
      ok: false,
      tools: false,
      streaming: false,
      at: Date.now(),
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
