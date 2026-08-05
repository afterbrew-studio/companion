import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import type { AuthUser } from '@moxxy/companion-contracts';
import { badRequest, defineRoutes, forbidden, notFound, paths, route } from '@moxxy/companion-sdk/server';
import type { PipelinePreview, PipelinePreviewStep, PlaygroundRunResult } from '../contract/index.js';
import evaluationRoutes from './evaluation-routes.js';
import productionEvaluationRoutes from './production-evaluation-routes.js';
import { buildPlaygroundPrompt, MAX_PLAYGROUND_PROMPT_CHARS } from './playground.js';

/**
 * Exploratory one-shots plus the zero-side-effect pipeline preview. Saved,
 * deterministic corpus routes live in evaluation-routes.ts and are composed
 * here so this module still exposes one route factory.
 */

const runSchema = z
  .object({
    prompt: z.string().trim().min(4).max(64_000),
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
  })
  .strict();

export default defineRoutes((ctx) => {
  const op = ctx.services.get('operate');
  const workspace = ctx.services.get('workspace');
  const requireAgentRun: (user: AuthUser | null) => asserts user is AuthUser = (user) => {
    if (!user || !ctx.rbac.allows(user, 'runs:read') || !ctx.rbac.allows(user, 'runs:act')) {
      throw forbidden('this action also requires runs:read and runs:act');
    }
  };

  return [
    route({
      method: 'POST',
      path: '/api/playground/run',
      access: 'playground:run',
      body: runSchema,
      handler: async ({ body, user }): Promise<PlaygroundRunResult> => {
        requireAgentRun(user);
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

        const prompt = boundedPrompt(
          buildPlaygroundPrompt({ input: body.prompt, repo: body.repo ?? null, skill }),
        );
        const { runId, finalMessage } = await op.orchestrator.runOneShot({
          kind: 'analysis',
          task: 'playground.run',
          title: skill
            ? `Skill dry-run: ${skill.name}`
            : `Playground: ${body.prompt.replace(/\s+/g, ' ').slice(0, 60)}`,
          cwd,
          repo: body.repo ?? null,
          // Playground runs are user-authored even when they use scratch. They
          // must never become globally-visible "system" runs.
          userId: user!.username,
          prompt,
          timeoutMs: body.timeoutMs,
        });
        return { runId, message: finalMessage };
      },
    }),

    ...evaluationRoutes(ctx),
    ...productionEvaluationRoutes(ctx),

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
        const { client } = await code.githubAccounts.verifiedClientFor('fetch', repo, {
          username: user!.username,
        });
        if (!client) throw notFound(`repo ${repo} not found`);
        const repoRow = code.repos.get(repo);
        if (!repoRow) throw notFound(`repo ${repo} not found`);

        const pipeline = code.pipelines.list(repoRow.workspace_id).find((candidate) => candidate.id === pipelineId);
        if (!pipeline) throw notFound(`pipeline ${pipelineId} not found`);
        if (pipeline.type !== 'pr') throw badRequest('only pr pipelines can be previewed against a PR');
        const pr = code.prs.get(repo, prNumber);
        if (!pr) throw notFound(`PR ${repo}#${prNumber} not found`);

        // This is exactly start()'s snapshot resolution. An unresolvable ref is
        // the one pre-halt knowable without executing any step.
        const resolved = code.pipelines.resolveSteps(pipeline.steps, pipeline.type);
        let halted = false;
        const steps: PipelinePreviewStep[] = resolved.map((resolvedStep, index) => {
          const source = pipeline.steps[index]!.type;
          if (!resolvedStep.ok) {
            halted = true;
            return {
              name: resolvedStep.name,
              kind: 'unknown',
              onFailure: null,
              source,
              config: null,
              willRun: false,
              note: resolvedStep.reason,
            };
          }
          if (halted) {
            return {
              name: resolvedStep.step.name,
              kind: resolvedStep.step.kind,
              onFailure: resolvedStep.step.onFailure,
              source,
              config: resolvedStep.step.config,
              willRun: false,
              note: 'skipped — an unresolvable step above halts the pipeline',
            };
          }
          return {
            name: resolvedStep.step.name,
            kind: resolvedStep.step.kind,
            onFailure: resolvedStep.step.onFailure,
            source,
            config: resolvedStep.step.config,
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
            autoRunOnPrUpdate: pipeline.autoRunOnPrUpdate,
          },
          target: { repo, prNumber, title: pr.title, author: pr.author },
          steps,
        };
      },
    }),
  ];
});

function boundedPrompt(prompt: string): string {
  if (prompt.length > MAX_PLAYGROUND_PROMPT_CHARS) {
    throw badRequest(
      `the assembled playground prompt is ${prompt.length.toLocaleString()} characters; reduce it below ${MAX_PLAYGROUND_PROMPT_CHARS.toLocaleString()}`,
    );
  }
  return prompt;
}
