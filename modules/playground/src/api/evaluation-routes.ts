import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import type { AuthUser } from '@moxxy/companion-contracts';
import {
  badRequest,
  created,
  defineRoutes,
  forbidden,
  HttpError,
  notFound,
  paths,
  route,
} from '@moxxy/companion-sdk/server';
import type {
  PlaygroundEvaluationCaseInput,
  PlaygroundEvaluationCaseRecord,
  PlaygroundEvaluationRun,
  PlaygroundEvaluationSnapshot,
} from '../contract/index.js';
import { evaluatePlaygroundResponse } from './evaluation.js';
import { buildPlaygroundPrompt, MAX_PLAYGROUND_PROMPT_CHARS, PLAYGROUND_PROMPT_VERSION } from './playground.js';

const jsonPrimitiveSchema = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const jsonPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z_][\w-]*(?:\.(?:[A-Za-z_][\w-]*|\d+))*$/, 'use a dot path such as verdict.qualityClass');
const expectedJsonSchema = z
  .record(jsonPathSchema, z.union([jsonPrimitiveSchema, z.array(jsonPrimitiveSchema).min(1).max(12)]))
  .refine((value) => Object.keys(value).length <= 20, 'at most 20 expected JSON values');
const expectationSchema = z
  .object({
    responseFormat: z.enum(['text', 'json']),
    requiredPhrases: z.array(z.string().trim().min(1).max(200)).max(20),
    forbiddenPhrases: z.array(z.string().trim().min(1).max(200)).max(20),
    requiredJsonPaths: z.array(jsonPathSchema).max(20),
    expectedJson: expectedJsonSchema,
    maxDurationMs: z.number().int().min(1_000).max(10 * 60_000).nullable(),
    maxInputTokens: z.number().int().min(1).max(2_000_000).nullable(),
    maxOutputTokens: z.number().int().min(1).max(500_000).nullable(),
  })
  .strict();
const caseFieldsSchema = z
  .object({
    name: z.string().trim().min(3).max(100),
    description: z.string().trim().max(1_000),
    prompt: z.string().trim().min(4).max(64_000),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable(),
    skill: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable(),
    timeoutMs: z.number().int().min(60_000).max(10 * 60_000),
    tags: z.array(z.string().trim().min(1).max(40)).max(12),
    safetyCritical: z.boolean(),
    expectation: expectationSchema,
  })
  .strict();
const meaningfulExpectation = (
  body: z.infer<typeof caseFieldsSchema>,
  refinement: z.RefinementCtx,
): void => {
  const expected = body.expectation;
  if (
    expected.responseFormat === 'text' &&
    expected.requiredPhrases.length === 0 &&
    expected.forbiddenPhrases.length === 0 &&
    expected.requiredJsonPaths.length === 0 &&
    Object.keys(expected.expectedJson).length === 0 &&
    expected.maxDurationMs === null &&
    expected.maxInputTokens === null &&
    expected.maxOutputTokens === null
  ) {
    refinement.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectation'],
      message: 'add at least one explicit pass/fail criterion',
    });
  }
};
const caseCreateSchema = caseFieldsSchema.superRefine(meaningfulExpectation);
const caseUpdateSchema = caseFieldsSchema
  .extend({ expectedRevision: z.number().int().positive() })
  .superRefine(meaningfulExpectation);

/** Saved, deterministic evaluation corpus. Kept separate from exploratory routes. */
export default defineRoutes((ctx) => {
  const op = ctx.services.get('operate');
  const workspace = ctx.services.get('workspace');
  const evaluations = ctx.services.get('playground').evaluations;
  const activeEvaluations = new Set<string>();

  const requireAgentRun: (user: AuthUser | null) => asserts user is AuthUser = (user) => {
    if (!user || !ctx.rbac.allows(user, 'runs:read') || !ctx.rbac.allows(user, 'runs:act')) {
      throw forbidden('this action also requires runs:read and runs:act');
    }
  };

  const requireCase = (id: string, user: AuthUser): PlaygroundEvaluationCaseRecord => {
    const record = evaluations.getCase(id);
    const accessible = record
      ? record.repo
        ? workspace.canAccessRepo(user, record.repo)
        : record.ownerId === user.username
      : false;
    if (!record || !accessible) throw notFound(`evaluation case ${id} not found`);
    return record;
  };

  const scopeForCase = (
    input: PlaygroundEvaluationCaseInput,
    user: AuthUser,
    ownerId = user.username,
  ): { readonly workspaceId: string | null; readonly ownerId: string } => {
    if (input.skill && !op.skills.get(input.skill)) throw notFound(`skill ${input.skill} not found`);
    if (!input.repo) return { workspaceId: null, ownerId };
    const code = ctx.services.tryGet('code');
    if (!code) throw badRequest('repo-backed evaluation cases need the code module enabled');
    if (!workspace.canAccessRepo(user, input.repo)) throw notFound(`repo ${input.repo} not found`);
    const repo = code.repos.get(input.repo);
    if (!repo) throw notFound(`repo ${input.repo} not found`);
    return { workspaceId: repo.workspace_id, ownerId };
  };

  const execute = async (
    evaluationCase: PlaygroundEvaluationCaseRecord,
    user: AuthUser,
  ): Promise<PlaygroundEvaluationRun> => {
    const startedAt = Date.now();
    let runId: string | null = null;
    let message: string | null = null;
    let error: string | null = null;
    let model: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    try {
      let cwd: string;
      if (evaluationCase.repo) {
        if (!workspace.canAccessRepo(user, evaluationCase.repo)) {
          throw notFound(`repo ${evaluationCase.repo} not found`);
        }
        if (!op.checkouts.hasClone(evaluationCase.repo)) {
          throw badRequest(`${evaluationCase.repo} has no local clone yet — sync it from the Code area first`);
        }
        cwd = op.checkouts.cloneDir(evaluationCase.repo);
      } else {
        cwd = paths.scratch();
        mkdirSync(cwd, { recursive: true });
      }
      const skill = evaluationCase.skill ? op.skills.get(evaluationCase.skill) : null;
      if (evaluationCase.skill && !skill) throw notFound(`skill ${evaluationCase.skill} not found`);

      const prompt = boundedPrompt(
        buildPlaygroundPrompt({
          input: evaluationCase.prompt,
          repo: evaluationCase.repo,
          skill,
          responseFormat: evaluationCase.expectation.responseFormat,
        }),
      );
      const result = await op.orchestrator.runOneShot({
        kind: 'analysis',
        task: 'playground.run',
        title: `Evaluation: ${evaluationCase.name}`,
        cwd,
        repo: evaluationCase.repo,
        userId: user.username,
        prompt,
        timeoutMs: evaluationCase.timeoutMs,
        onStarted: (id) => {
          runId = id;
        },
      });
      runId = result.runId;
      message = result.finalMessage;
      const row = op.runsStore.get(result.runId);
      model = row?.model ?? null;
      if (row && row.input_tokens + row.output_tokens > 0) {
        inputTokens = row.input_tokens;
        outputTokens = row.output_tokens;
      }
    } catch (err) {
      error = compactError(err);
      if (runId) {
        const row = op.runsStore.get(runId);
        model = row?.model ?? null;
        if (row && row.input_tokens + row.output_tokens > 0) {
          inputTokens = row.input_tokens;
          outputTokens = row.output_tokens;
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    const outcome = evaluatePlaygroundResponse(message, evaluationCase.expectation, {
      durationMs,
      inputTokens,
      outputTokens,
    });
    return {
      id: `evalrun-${randomUUID()}`,
      caseId: evaluationCase.id,
      caseName: evaluationCase.name,
      caseRevision: evaluationCase.revision,
      promptVersion: PLAYGROUND_PROMPT_VERSION,
      runId,
      status: error ? 'error' : outcome.passed ? 'passed' : 'failed',
      checks: outcome.checks,
      message,
      error,
      durationMs,
      inputTokens,
      outputTokens,
      model,
      createdAt: Date.now(),
    };
  };

  return [
    route({
      method: 'GET',
      path: '/api/playground/evaluation-cases',
      access: 'playground:run',
      handler: ({ user }): PlaygroundEvaluationSnapshot => {
        const accessible = workspace.accessibleIds(user!);
        const cases = evaluations
          .listCases(user!.username, accessible)
          // Repo moves cannot leave the old workspace reading a saved fixture.
          .filter((record) => !record.repo || workspace.canAccessRepo(user!, record.repo));
        const visibleCaseIds = new Set(cases.map((record) => record.id));
        return {
          cases,
          runs: evaluations
            .listRuns(user!.username, accessible)
            .filter((run) => visibleCaseIds.has(run.caseId)),
        };
      },
    }),
    route({
      method: 'POST',
      path: '/api/playground/evaluation-cases',
      access: 'playground:run',
      body: caseCreateSchema,
      handler: ({ body, user }) => {
        const now = Date.now();
        const input = normalizeCaseInput(body);
        const record: PlaygroundEvaluationCaseRecord = {
          ...input,
          id: `eval-${randomUUID()}`,
          ...scopeForCase(input, user!),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        evaluations.insertCase(record);
        ctx.broadcast({ t: 'playground.changed' });
        return created({ evaluationCase: record });
      },
    }),
    route({
      method: 'PUT',
      path: '/api/playground/evaluation-cases/:id',
      access: 'playground:run',
      body: caseUpdateSchema,
      handler: ({ params, body, user }) => {
        const existing = requireCase(params.id, user!);
        if (activeEvaluations.has(params.id)) {
          throw new HttpError(409, 'wait for the active evaluation to finish before editing');
        }
        const input = normalizeCaseInput(body);
        if (!input.repo && existing.ownerId !== user!.username) {
          throw forbidden('only the case owner can turn a workspace case into a private scratch case');
        }
        const updated = evaluations.updateCase(
          params.id,
          body.expectedRevision,
          input,
          scopeForCase(input, user!, existing.ownerId),
        );
        if (!updated) throw new HttpError(409, 'the evaluation case changed; reload it before saving');
        ctx.broadcast({ t: 'playground.changed' });
        return { evaluationCase: updated };
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/playground/evaluation-cases/:id',
      access: 'playground:run',
      handler: ({ params, user }) => {
        requireCase(params.id, user!);
        if (activeEvaluations.has(params.id)) {
          throw new HttpError(409, 'wait for the active evaluation to finish before deleting');
        }
        evaluations.deleteCase(params.id);
        ctx.broadcast({ t: 'playground.changed' });
        return { ok: true as const };
      },
    }),
    route({
      method: 'POST',
      path: '/api/playground/evaluation-cases/:id/run',
      access: 'playground:run',
      handler: async ({ params, user }): Promise<{ evaluationRun: PlaygroundEvaluationRun }> => {
        requireAgentRun(user);
        const evaluationCase = requireCase(params.id, user!);
        if (activeEvaluations.has(evaluationCase.id)) {
          throw new HttpError(409, 'this evaluation case is already running');
        }
        activeEvaluations.add(evaluationCase.id);
        try {
          const evaluationRun = await execute(evaluationCase, user!);
          evaluations.insertRun(evaluationRun, evaluationCase);
          ctx.broadcast({ t: 'playground.changed' });
          return { evaluationRun };
        } finally {
          activeEvaluations.delete(evaluationCase.id);
        }
      },
    }),
  ];
});

function normalizeCaseInput(input: PlaygroundEvaluationCaseInput): PlaygroundEvaluationCaseInput {
  return {
    name: input.name,
    description: input.description,
    prompt: input.prompt,
    repo: input.repo,
    skill: input.skill,
    timeoutMs: input.timeoutMs,
    tags: [...new Set(input.tags.map((tag) => tag.toLowerCase()))],
    safetyCritical: input.safetyCritical,
    expectation: {
      ...input.expectation,
      requiredPhrases: [...new Set(input.expectation.requiredPhrases)],
      forbiddenPhrases: [...new Set(input.expectation.forbiddenPhrases)],
      requiredJsonPaths: [...new Set(input.expectation.requiredJsonPaths)],
    },
  };
}

function compactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 500) || 'evaluation run failed';
}

function boundedPrompt(prompt: string): string {
  if (prompt.length > MAX_PLAYGROUND_PROMPT_CHARS) {
    throw badRequest(
      `the assembled playground prompt is ${prompt.length.toLocaleString()} characters; reduce it below ${MAX_PLAYGROUND_PROMPT_CHARS.toLocaleString()}`,
    );
  }
  return prompt;
}
