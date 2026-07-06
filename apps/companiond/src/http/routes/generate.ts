import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { savePipelineSchema, saveStepDefinitionSchema } from '../../pipelines/pipelines.js';
import { route, created, badRequest, notFound, type CompiledRoute } from '../router.js';
import { paths } from '../../config.js';
import type { ApiDeps } from '../deps.js';

/**
 * AI generation: a bounded companion runner (one-shot agent turn) drafts
 * skills, custom steps, and pipelines from plain-language instructions. Drafts
 * are validated against the same zod schemas as manual input; skills come back
 * for review in the editor, steps/pipelines are created (never auto-run) and
 * opened for editing.
 */

const genSchema = z.object({ instructions: z.string().min(8).max(4000) });

const skillDraftSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  content: z.string().min(20).max(64_000),
});

const STEP_SCHEMA_DOC = `A step is one of (JSON):
- { "kind": "checks-gate", "name": string, "onFailure": "halt"|"continue", "config": { "allowPending": boolean } } — fail while GitHub CI is red
- { "kind": "ai-review", "name": string, "onFailure": ..., "config": { "post": boolean, "failOn": "request_changes"|"high_risk"|"never" } } — built-in AI code review
- { "kind": "agent", "name": string, "onFailure": ..., "config": { "prompt": string } } — custom agent prompt; the agent replies with a pass/fail verdict
- { "kind": "label", "name": string, "onFailure": ..., "config": { "labels": string[] (1-8) } } — add labels to the PR
- { "kind": "comment", "name": string, "onFailure": ..., "config": { "body": string } } — post a comment (supports {{pr.title}} templates)`;

/** The last fenced JSON block (or the widest brace span) in an agent reply. */
function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const raw = fences.length > 0 ? fences[fences.length - 1]![1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

function scratchCwd(): string {
  const dir = paths.scratch();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function generateRoutes(deps: ApiDeps): CompiledRoute[] {
  /** Agents auto-discover moxxy-home skills; tell the generator what exists. */
  const skillsNote = (): string => {
    const names = deps.skills.list().map((sk) => sk.name);
    return names.length > 0
      ? `\nAgents auto-discover these skills — an "agent" step prompt can apply one by mentioning its name: ${names.join(', ')}.\n`
      : '';
  };

  const oneShot = async (title: string, prompt: string): Promise<string> => {
    const { finalMessage } = await deps.orchestrator.runOneShot({
      kind: 'analysis',
      title,
      cwd: scratchCwd(),
      prompt,
      timeoutMs: 4 * 60_000,
    });
    if (!finalMessage?.trim()) throw badRequest('the generation run produced no output — try again');
    return finalMessage;
  };

  const requireWorkspace = (id: string) => {
    const ws = deps.store.getWorkspace(id);
    if (!ws) throw notFound(`workspace ${id} not found`);
    return ws;
  };

  return [
    route({
      method: 'POST',
      path: '/api/skills/generate',
      access: 'skills:manage',
      body: genSchema,
      handler: async ({ body }) => {
        const reply = await oneShot(
          'Generate skill',
          `You are drafting an agent skill for Companion — a markdown file injected into every agent run (triage, code review, fixes) to teach conventions or domain knowledge. Do not modify any files.

The maintainer wants: ${body.instructions}

Reply with ONLY a fenced json block:
\`\`\`json
{ "name": "<kebab-case-slug>", "content": "<the full markdown skill: when to use it, then concrete instructions>" }
\`\`\``,
        );
        try {
          return { draft: skillDraftSchema.parse(extractJson(reply)) };
        } catch {
          throw badRequest('the agent reply was not a valid skill draft — try rephrasing');
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/step-definitions/generate',
      access: 'pipelines:manage',
      body: genSchema,
      handler: async ({ params, body }) => {
        requireWorkspace(params.id);
        const reply = await oneShot(
          'Generate custom step',
          `You are drafting one reusable pipeline step for Companion's PR pipelines. Do not modify any files.

${STEP_SCHEMA_DOC}
${skillsNote()}
The maintainer wants: ${body.instructions}

Reply with ONLY a fenced json block matching:
\`\`\`json
{ "name": "<step library name>", "description": "<one line>", "step": <one step object as documented> }
\`\`\``,
        );
        let draft;
        try {
          draft = saveStepDefinitionSchema.parse(extractJson(reply));
        } catch {
          throw badRequest('the agent reply was not a valid step definition — try rephrasing');
        }
        return created({ stepDefinition: deps.pipelines.createStepDefinition(params.id, draft) });
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/pipelines/generate',
      access: 'pipelines:manage',
      body: genSchema,
      handler: async ({ params, body }) => {
        requireWorkspace(params.id);
        const reply = await oneShot(
          'Generate pipeline',
          `You are drafting a pipeline for Companion: an ordered set of steps with a type that decides its payload. Types: "pr" (runs against pull requests; all step kinds allowed), "issue" (runs against issues; only agent/label/comment steps), "platform" (runs against the repo itself; agent steps only). Pick the type that fits the request. Do not modify any files.

${STEP_SCHEMA_DOC}
${skillsNote()}
The maintainer wants: ${body.instructions}

Reply with ONLY a fenced json block matching:
\`\`\`json
{ "type": "pr" | "issue" | "platform", "name": "<pipeline name>", "description": "<one line>", "steps": [ { "type": "inline", "step": <step object> }, ... ] }
\`\`\``,
        );
        let draft;
        try {
          // Generated pipelines never auto-run — a human flips that on after review.
          draft = savePipelineSchema.parse({ ...(extractJson(reply) as object), autoRunOnPrOpen: false });
        } catch {
          throw badRequest('the agent reply was not a valid pipeline — try rephrasing');
        }
        return created({ pipeline: deps.pipelines.create(params.id, draft) });
      },
    }),
  ];
}
