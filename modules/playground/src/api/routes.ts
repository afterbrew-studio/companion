import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { defineRoutes, route, badRequest, notFound } from '@moxxy-ai/companion-sdk/server';
import { paths } from '@moxxy-ai/companion-sdk/server';
import type { PipelinePreview, PipelinePreviewStep, PlaygroundRunResult } from '../contract/index.js';
import { buildPlaygroundPrompt } from './playground.js';

/**
 * The playground's HTTP surface. Both routes are gated by `playground:run`;
 * the run endpoint awaits the whole one-shot (same synchronous shape as the
 * generate-* endpoints) with a hard timeout ceiling, and the pipeline preview
 * is a pure read — it resolves exactly what the engine would execute without
 * creating a run.
 */

const runSchema = z.object({
  prompt: z.string().trim().min(4).max(16_000),
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
  skill: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  /** Playground runs are exploratory — bounded hard, never long-haul. */
  timeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(10 * 60_000)
    .default(3 * 60_000),
});

export default defineRoutes((ctx) => {
  const op = ctx.services.get('operate');
  const workspace = ctx.services.get('workspace');

  return [
    route({
      method: 'POST',
      path: '/api/playground/run',
      access: 'playground:run',
      body: runSchema,
      handler: async ({ body, user }): Promise<PlaygroundRunResult> => {
        let cwd: string;
        if (body.repo) {
          // Private-workspace repos read as "not found" to outsiders.
          if (!workspace.canAccessRepo(user!, body.repo)) throw notFound(`repo ${body.repo} not found`);
          if (!op.checkouts.hasClone(body.repo)) {
            throw badRequest(`${body.repo} has no local clone yet — sync it from the Code area first`);
          }
          cwd = op.checkouts.cloneDir(body.repo);
        } else {
          cwd = paths.scratch();
          mkdirSync(cwd, { recursive: true });
        }
        const skill = body.skill ? op.skills.get(body.skill) : null;
        if (body.skill && !skill) throw notFound(`skill ${body.skill} not found`);

        const { runId, finalMessage } = await op.orchestrator.runOneShot({
          kind: 'analysis',
          task: 'playground.run',
          title: skill
            ? `Skill dry-run: ${skill.name}`
            : `Playground: ${body.prompt.replace(/\s+/g, ' ').slice(0, 60)}`,
          cwd,
          repo: body.repo ?? null,
          userId: body.repo ? user!.username : null,
          prompt: buildPlaygroundPrompt({ input: body.prompt, repo: body.repo ?? null, skill }),
          timeoutMs: body.timeoutMs,
        });
        // null message = the run failed (already marked so) — surface it as-is,
        // the client links to the transcript instead of pretending success.
        return { runId, message: finalMessage };
      },
    }),

    route({
      method: 'GET',
      path: '/api/playground/pipeline-preview',
      access: 'playground:run',
      handler: async ({ query, user }): Promise<PipelinePreview> => {
        const repo = query.get('repo') ?? '';
        const pipelineId = query.get('pipelineId') ?? '';
        const prNumber = Number(query.get('pr') ?? '');
        if (!repo || !pipelineId || !Number.isInteger(prNumber) || prNumber <= 0) {
          throw badRequest('repo, pipelineId and pr are required');
        }
        const code = ctx.services.tryGet('code');
        if (!code) throw badRequest('pipeline previews need the code module enabled');
        if (!workspace.canAccessRepo(user!, repo)) throw notFound(`repo ${repo} not found`);
        const { client } = await code.githubAccounts.verifiedClientFor('fetch', repo, { username: user!.username });
        if (!client) throw notFound(`repo ${repo} not found`);
        const repoRow = code.repos.get(repo);
        if (!repoRow) throw notFound(`repo ${repo} not found`);

        const pipeline = code.pipelines.list(repoRow.workspace_id).find((p) => p.id === pipelineId);
        if (!pipeline) throw notFound(`pipeline ${pipelineId} not found`);
        if (pipeline.type !== 'pr') throw badRequest('only pr pipelines can be previewed against a PR');
        const pr = code.prs.get(repo, prNumber);
        if (!pr) throw notFound(`PR ${repo}#${prNumber} not found`);

        // The same resolution start() snapshots — then mirror execute()'s one
        // decision knowable without running: an unresolvable ref pre-halts.
        const resolved = code.pipelines.resolveSteps(pipeline.steps, pipeline.type);
        let halted = false;
        const steps: PipelinePreviewStep[] = resolved.map((r, i) => {
          const source = pipeline.steps[i]!.type;
          if (!r.ok) {
            halted = true;
            return { name: r.name, kind: 'unknown', onFailure: null, source, config: null, willRun: false, note: r.reason };
          }
          if (halted) {
            return {
              name: r.step.name,
              kind: r.step.kind,
              onFailure: r.step.onFailure,
              source,
              config: r.step.config,
              willRun: false,
              note: 'skipped — an unresolvable step above halts the pipeline',
            };
          }
          return {
            name: r.step.name,
            kind: r.step.kind,
            onFailure: r.step.onFailure,
            source,
            config: r.step.config,
            willRun: true,
            note: null,
          };
        });

        return {
          pipeline: {
            id: pipeline.id,
            name: pipeline.name,
            description: pipeline.description,
            type: pipeline.type,
            autoRunOnPrOpen: pipeline.autoRunOnPrOpen,
          },
          target: { repo, prNumber, title: pr.title, author: pr.author },
          steps,
        };
      },
    }),
  ];
});
