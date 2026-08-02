import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AuthUser, ServiceMap } from '@moxxy/companion-contracts';
import { badRequest, HttpError, notFound, paths } from '@moxxy/companion-sdk/server';
import type {
  PlaygroundEvaluationCheck,
  PlaygroundProductionActiveRun,
  PlaygroundProductionEvaluationCase,
  PlaygroundProductionEvaluationRun,
  PlaygroundProductionEvaluationSnapshot,
  PlaygroundProductionEvaluationSuite,
  PlaygroundProductionRunConfiguration,
  PlaygroundRolloutCaseResult,
  PlaygroundRolloutGate,
} from '../contract/index.js';
import { evaluatePlaygroundResponse } from './evaluation.js';
import type { PlaygroundEvaluationStore } from './evaluation-store.js';
import {
  PRODUCTION_EVALUATION_CASES,
  publicProductionCase,
  type ProductionEvaluationDefinition,
} from './production-corpus.js';
import { MAX_PLAYGROUND_PROMPT_CHARS } from './playground.js';
import { ProductionSuiteBudgetGuard } from './production-suite-budget.js';

type Operate = ServiceMap['operate'];
type Adapter = NonNullable<ReturnType<Operate['promptEvaluations']['get']>>;
type RunLane = ReturnType<Operate['orchestrator']['userLane']>;

interface AvailableCase {
  readonly definition: ProductionEvaluationDefinition;
  readonly adapter: Adapter;
  readonly record: PlaygroundProductionEvaluationCase;
}

interface ActiveEvaluation {
  readonly ownerId: string;
  readonly caseId: string;
  readonly suiteId: string | null;
  phase: PlaygroundProductionActiveRun['phase'];
  queueId: string | null;
  runId: string | null;
  readonly startedAt: number;
  cancelled: boolean;
}

interface ActiveSuite {
  readonly id: string;
  readonly ownerId: string;
  readonly lane: RunLane;
  readonly budget: ProductionSuiteBudgetGuard;
  budgetSyncTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  completion: Promise<void> | null;
  cancelled: boolean;
}

interface ProductionEvaluationDeps {
  readonly store: PlaygroundEvaluationStore;
  readonly operate: Operate;
  readonly isEnabled: (moduleId: string) => boolean;
  readonly broadcast: () => void;
  readonly log: (message: string, detail?: Record<string, unknown>) => void;
}

/** Durable release-gate orchestration over exact production prompt/parser seams. */
export class ProductionEvaluations {
  private readonly active = new Map<string, ActiveEvaluation>();
  private readonly activeSuites = new Map<string, ActiveSuite>();

  constructor(private readonly deps: ProductionEvaluationDeps) {}

  snapshot(user: AuthUser): PlaygroundProductionEvaluationSnapshot {
    const available = this.availableCases();
    const caseIds = new Set(available.map(({ definition }) => definition.id));
    const runs = this.deps.store
      .listProductionRuns(user.username)
      .filter((run) => caseIds.has(run.caseId));
    const currentFingerprints = new Map(
      available.map(({ adapter }) => [
        adapter.id,
        configurationFor(this.deps.operate, user.username, adapter.task).fingerprint,
      ]),
    );
    return {
      cases: available.map(({ record }) => record),
      runs,
      rolloutGate: buildRolloutGate(
        available.map(({ record }) => record),
        runs,
        currentFingerprints,
      ),
      active: [...this.active.values()]
        .filter((entry) => entry.ownerId === user.username && caseIds.has(entry.caseId))
        .map(({ caseId, phase, queueId, runId, startedAt }) => ({ caseId, phase, queueId, runId, startedAt })),
      suites: this.deps.store.listProductionSuites(user.username),
    };
  }

  async run(caseId: string, user: AuthUser): Promise<PlaygroundProductionEvaluationRun> {
    const selected = this.requireCase(caseId);
    const key = activeKey(user.username, caseId);
    if (this.active.has(key)) throw new HttpError(409, 'this production evaluation is already running');
    if (this.activeSuites.has(user.username)) {
      throw new HttpError(409, 'wait for the active release gate to finish or cancel it first');
    }
    const activity = this.beginActivity(user.username, caseId, null);
    try {
      const run = await this.execute(selected, user, activity, this.deps.operate.orchestrator.userLane(user.username));
      this.deps.store.insertProductionRun(run);
      return run;
    } finally {
      this.active.delete(key);
      this.deps.broadcast();
    }
  }

  async cancelCase(caseId: string, user: AuthUser): Promise<void> {
    this.requireCase(caseId);
    const activity = this.active.get(activeKey(user.username, caseId));
    if (!activity) return;
    if (activity.suiteId) {
      await this.cancelSuite(activity.suiteId, user);
      return;
    }
    activity.cancelled = true;
    await this.cancelActivity(activity);
    this.deps.broadcast();
  }

  startSuite(user: AuthUser): PlaygroundProductionEvaluationSuite {
    const selected = this.availableCases();
    if (selected.length === 0) throw badRequest('no production evaluation adapters are enabled');
    if (this.activeSuites.has(user.username)) {
      throw new HttpError(409, 'a production release gate is already running');
    }
    if ([...this.active.values()].some((entry) => entry.ownerId === user.username)) {
      throw new HttpError(409, 'wait for the active production evaluation to finish or cancel it first');
    }
    const plan = selected.flatMap((item) =>
      Array.from({ length: item.record.requiredPasses }, () => item),
    );
    const now = Date.now();
    const budget = new ProductionSuiteBudgetGuard();
    // Capture the user's lane before persistence. If reading configuration
    // fails, no orphaned `running` suite is left behind.
    const lane = this.deps.operate.orchestrator.userLane(user.username);
    const suite: PlaygroundProductionEvaluationSuite = {
      id: `evalsuite-${randomUUID()}`,
      ownerId: user.username,
      status: 'running',
      total: plan.length,
      completed: 0,
      currentCaseId: null,
      currentCaseName: null,
      caseIds: plan.map(({ definition }) => definition.id),
      budget: budget.snapshot(),
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.deps.store.insertProductionSuite(suite);
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err))) {
        throw new HttpError(409, 'a production release gate is already running');
      }
      throw err;
    }
    const state: ActiveSuite = {
      id: suite.id,
      ownerId: user.username,
      lane,
      budget,
      budgetSyncTimer: null,
      deadlineTimer: null,
      completion: null,
      cancelled: false,
    };
    this.activeSuites.set(user.username, state);
    state.deadlineTimer = setTimeout(() => {
      this.stopSuiteForBudget(state, 'production release gate time budget exhausted');
    }, Math.max(1, budget.deadlineAt - Date.now()));
    state.deadlineTimer.unref();
    this.deps.broadcast();
    state.completion = this.executeSuite(suite, plan, user, state);
    void state.completion.catch((err) => {
      this.deps.log('production evaluation suite escaped its lifecycle guard', {
        suiteId: state.id,
        err: compactError(err),
      });
    });
    return suite;
  }

  async cancelSuite(id: string, user: AuthUser): Promise<void> {
    const suite = this.deps.store.getProductionSuite(id);
    if (!suite || suite.ownerId !== user.username) throw notFound(`production evaluation suite ${id} not found`);
    if (suite.status !== 'running') return;
    // Persist terminal intent before touching the queue/run; late completions
    // then lose their compare-and-set updates instead of reviving the suite.
    this.deps.store.finishProductionSuite(id, 'cancelled', null);
    const state = this.activeSuites.get(user.username);
    if (state?.id === id) {
      state.cancelled = true;
      this.clearSuiteTimers(state);
    }
    const activity = [...this.active.values()].find(
      (entry) => entry.ownerId === user.username && entry.suiteId === id,
    );
    if (activity) {
      activity.cancelled = true;
      await this.cancelActivity(activity);
    }
    this.deps.broadcast();
  }

  recover(): number {
    return this.deps.store.recoverProductionSuites();
  }

  async stop(): Promise<void> {
    const suites = [...this.activeSuites.values()];
    for (const suite of suites) {
      suite.cancelled = true;
      this.clearSuiteTimers(suite);
      this.deps.store.finishProductionSuite(
        suite.id,
        'interrupted',
        'The Playground module stopped while this release gate was running; start it again.',
      );
    }
    const activities = [...this.active.values()];
    for (const activity of activities) activity.cancelled = true;
    await Promise.allSettled(activities.map((activity) => this.cancelActivity(activity)));
    await Promise.allSettled(suites.flatMap((suite) => suite.completion ? [suite.completion] : []));
    this.active.clear();
    this.activeSuites.clear();
    this.deps.broadcast();
  }

  private availableCases(): AvailableCase[] {
    const adapters = new Map(
      this.deps.operate.promptEvaluations
        .descriptors()
        .filter((descriptor) => this.deps.isEnabled(descriptor.moduleId))
        .map((descriptor) => [descriptor.id, descriptor]),
    );
    return PRODUCTION_EVALUATION_CASES.flatMap((definition) => {
      const descriptor = adapters.get(definition.adapterId);
      const adapter = descriptor ? this.deps.operate.promptEvaluations.get(descriptor.id) : null;
      if (!descriptor || !adapter) return [];
      const prompt = adapter.buildPrompt(definition.fixture);
      return [{
        definition,
        adapter,
        record: publicProductionCase(definition, descriptor, promptFingerprint(prompt)),
      }];
    });
  }

  private requireCase(id: string): AvailableCase {
    const found = this.availableCases().find(({ definition }) => definition.id === id);
    if (!found) throw notFound(`production evaluation case ${id} not found`);
    return found;
  }

  private beginActivity(ownerId: string, caseId: string, suiteId: string | null): ActiveEvaluation {
    const activity: ActiveEvaluation = {
      ownerId,
      caseId,
      suiteId,
      phase: 'queued',
      queueId: null,
      runId: null,
      startedAt: Date.now(),
      cancelled: false,
    };
    this.active.set(activeKey(ownerId, caseId), activity);
    this.deps.broadcast();
    return activity;
  }

  private async executeSuite(
    suite: PlaygroundProductionEvaluationSuite,
    selected: ReadonlyArray<AvailableCase>,
    user: AuthUser,
    state: ActiveSuite,
  ): Promise<void> {
    try {
      let completed = 0;
      for (const item of selected) {
        if (state.cancelled || this.deps.store.getProductionSuite(suite.id)?.status !== 'running') break;
        if (!this.deps.store.updateProductionSuiteProgress(
          suite.id,
          completed,
          item.definition.id,
          item.definition.name,
        )) break;
        this.deps.broadcast();
        const activity = this.beginActivity(user.username, item.definition.id, suite.id);
        try {
          const run = await this.execute(item, user, activity, state.lane, state);
          this.deps.store.insertProductionRun(run);
        } finally {
          this.active.delete(activeKey(user.username, item.definition.id));
        }
        completed += 1;
        if (!this.deps.store.updateProductionSuiteProgress(suite.id, completed, null, null)) break;
        this.deps.broadcast();
      }
      if (!state.cancelled) {
        this.persistSuiteBudget(state);
        this.deps.store.finishProductionSuite(suite.id, 'completed', null);
      }
    } catch (err) {
      const error = compactError(err);
      this.persistSuiteBudget(state);
      this.deps.store.finishProductionSuite(suite.id, state.cancelled ? 'cancelled' : 'failed', error);
      this.deps.log('production evaluation suite failed', { suiteId: suite.id, err: error });
    } finally {
      this.clearSuiteTimers(state);
      this.activeSuites.delete(user.username);
      for (const [key, activity] of this.active) {
        if (activity.suiteId === suite.id) this.active.delete(key);
      }
      this.deps.broadcast();
    }
  }

  private async execute(
    selected: AvailableCase,
    user: AuthUser,
    activity: ActiveEvaluation,
    lane: RunLane,
    suiteState?: ActiveSuite,
  ): Promise<PlaygroundProductionEvaluationRun> {
    const { definition, adapter, record } = selected;
    const startedAt = Date.now();
    let message: string | null = null;
    let error: string | null = null;
    let parsedOutput: unknown = null;
    let parserCheck: PlaygroundEvaluationCheck = {
      kind: 'production_parser',
      label: 'Exact production parser accepts the response',
      passed: false,
      detail: 'The parser was not reached.',
    };
    const baseConfiguration = configurationFor(this.deps.operate, user.username, adapter.task, lane);
    let configuration = baseConfiguration;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let budgetError: string | null = null;

    try {
      const prompt = boundedPrompt(adapter.buildPrompt(definition.fixture));
      const cwd = paths.scratch();
      mkdirSync(cwd, { recursive: true });
      const result = await this.deps.operate.orchestrator.runOneShot({
        kind: 'analysis',
        task: adapter.task,
        lane,
        title: `Production evaluation: ${definition.name}`,
        cwd,
        userId: user.username,
        prompt,
        timeoutMs: suiteState ? suiteState.budget.timeoutFor(definition.timeoutMs) : definition.timeoutMs,
        onQueued: (queueId) => {
          activity.queueId = queueId;
          activity.phase = 'queued';
          this.deps.broadcast();
        },
        onStarted: (runId) => {
          activity.runId = runId;
          activity.phase = 'running';
          this.deps.broadcast();
        },
        onUsage: suiteState
          ? (runId) => {
              const stopReason = suiteState.budget.observeUsage(
                runId,
                this.deps.operate.usageForRun(runId),
              );
              if (stopReason) this.stopSuiteForBudget(suiteState, stopReason);
              else this.scheduleSuiteBudgetSync(suiteState);
            }
          : undefined,
        shouldStart: () => !activity.cancelled && !suiteState?.budget.stopped,
      });
      activity.runId = result.runId;
      message = result.finalMessage;
      const row = this.deps.operate.runsStore.get(result.runId);
      if (row && row.input_tokens + row.output_tokens > 0) {
        inputTokens = row.input_tokens;
        outputTokens = row.output_tokens;
      }
      configuration = withActualConfiguration(baseConfiguration, row);
      if (!activity.cancelled && message !== null) {
        activity.phase = 'evaluating';
        this.deps.broadcast();
        try {
          parsedOutput = adapter.parseResponse(message);
          parserCheck = {
            kind: 'production_parser',
            label: 'Exact production parser accepts the response',
            passed: true,
            detail: `Adapter ${adapter.id} v${adapter.version} parsed the model output.`,
          };
        } catch (err) {
          parserCheck = {
            kind: 'production_parser',
            label: 'Exact production parser accepts the response',
            passed: false,
            detail: compactError(err),
          };
        }
      }
    } catch (err) {
      error = compactError(err);
      if (suiteState?.budget.stopped) this.stopSuiteForBudget(suiteState, error);
      configuration = withActualConfiguration(
        baseConfiguration,
        activity.runId ? this.deps.operate.runsStore.get(activity.runId) : undefined,
      );
      const row = activity.runId ? this.deps.operate.runsStore.get(activity.runId) : undefined;
      if (row && row.input_tokens + row.output_tokens > 0) {
        inputTokens = row.input_tokens;
        outputTokens = row.output_tokens;
      }
    }

    const cancelledBeforeUsageReconciliation = activity.cancelled;
    if (suiteState && activity.runId) {
      const stopReason = suiteState.budget.recordUsage(
        activity.runId,
        this.deps.operate.usageForRun(activity.runId),
      );
      this.persistSuiteBudget(suiteState);
      if (stopReason) {
        budgetError = stopReason;
        this.stopSuiteForBudget(suiteState, stopReason);
      }
    }

    const durationMs = Date.now() - startedAt;
    const outcome = evaluatePlaygroundResponse(
      message,
      definition.expectation,
      { durationMs, inputTokens, outputTokens },
      parserCheck.passed ? parsedOutput : undefined,
    );
    const checks = [parserCheck, ...outcome.checks];
    return {
      id: `prodeval-${randomUUID()}`,
      caseId: definition.id,
      caseName: definition.name,
      caseRevision: definition.revision,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      promptFingerprint: record.promptFingerprint,
      runId: activity.runId,
      status: cancelledBeforeUsageReconciliation
        ? 'cancelled'
        : error || budgetError
          ? 'error'
          : checks.every((check) => check.passed)
            ? 'passed'
            : 'failed',
      checks,
      parsedOutput,
      message,
      error: cancelledBeforeUsageReconciliation ? null : (error ?? budgetError),
      durationMs,
      inputTokens,
      outputTokens,
      model: configuration.actualModel,
      configuration,
      ownerId: user.username,
      createdAt: Date.now(),
    };
  }

  private async cancelActivity(activity: ActiveEvaluation): Promise<void> {
    if (activity.queueId) this.deps.operate.orchestrator.cancelQueued(activity.queueId);
    if (activity.runId) {
      await this.deps.operate.orchestrator.stopRun(activity.runId).catch(() => undefined);
    }
  }

  /** Coalesce provider chatter so live budget visibility cannot become a refetch storm. */
  private scheduleSuiteBudgetSync(state: ActiveSuite): void {
    if (state.budgetSyncTimer || state.cancelled) return;
    state.budgetSyncTimer = setTimeout(() => {
      state.budgetSyncTimer = null;
      if (this.deps.store.updateProductionSuiteBudget(state.id, state.budget.snapshot())) {
        this.deps.broadcast();
      }
    }, 1_000);
    state.budgetSyncTimer.unref();
  }

  private persistSuiteBudget(state: ActiveSuite): void {
    if (state.budgetSyncTimer) clearTimeout(state.budgetSyncTimer);
    state.budgetSyncTimer = null;
    if (this.deps.store.updateProductionSuiteBudget(state.id, state.budget.snapshot())) {
      this.deps.broadcast();
    }
  }

  /** Persist the terminal fence before asynchronously reaping queued/running work. */
  private stopSuiteForBudget(state: ActiveSuite, reason: string): void {
    state.budget.stop(reason);
    this.persistSuiteBudget(state);
    if (!this.deps.store.finishProductionSuite(state.id, 'failed', reason)) return;
    state.cancelled = true;
    this.clearSuiteTimers(state);
    const activity = [...this.active.values()].find(
      (entry) => entry.ownerId === state.ownerId && entry.suiteId === state.id,
    );
    if (activity) {
      activity.cancelled = true;
      void this.cancelActivity(activity).catch((err) => {
        this.deps.log('could not reap a release-gate child after its budget stopped', {
          suiteId: state.id,
          err: compactError(err),
        });
      });
    }
    this.deps.broadcast();
  }

  private clearSuiteTimers(state: ActiveSuite): void {
    if (state.budgetSyncTimer) clearTimeout(state.budgetSyncTimer);
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    state.budgetSyncTimer = null;
    state.deadlineTimer = null;
  }
}

function configurationFor(
  op: Operate,
  username: string,
  task: string,
  lane = op.orchestrator.userLane(username),
): PlaygroundProductionRunConfiguration {
  const autoLane = lane.runnerId === null && lane.harness === null;
  const laneModels = op.orchestrator.laneModels(lane, [task]);
  const known = {
    task,
    taskModelPin: op.orchestrator.taskModelPin(task),
    laneRunnerId: lane.runnerId,
    laneHarness: lane.harness,
    laneTaskModel: autoLane ? null : (laneModels.pins[task] ?? null),
    laneDefaultModel: autoLane ? null : laneModels.defaultModel,
    daemonDefaultModel: op.orchestrator.defaultModelPreference(),
  };
  return {
    fingerprint: createHash('sha256').update(JSON.stringify(known)).digest('hex').slice(0, 20),
    ...known,
    actualModel: null,
    actualRunnerId: null,
    actualHarness: null,
  };
}

function withActualConfiguration(
  base: PlaygroundProductionRunConfiguration,
  row: ReturnType<Operate['runsStore']['get']>,
): PlaygroundProductionRunConfiguration {
  return {
    ...base,
    actualModel: row?.model ?? null,
    actualRunnerId: row?.runner_id ?? null,
    actualHarness: row?.harness ?? null,
  };
}

export function buildRolloutGate(
  cases: ReadonlyArray<PlaygroundProductionEvaluationCase>,
  runs: ReadonlyArray<PlaygroundProductionEvaluationRun>,
  currentFingerprints: ReadonlyMap<string, string>,
): PlaygroundRolloutGate {
  const byCase = new Map<string, PlaygroundProductionEvaluationRun[]>();
  for (const run of runs) {
    const history = byCase.get(run.caseId) ?? [];
    history.push(run);
    byCase.set(run.caseId, history);
  }
  const results: PlaygroundRolloutCaseResult[] = cases.map((record) => {
    const history = byCase.get(record.id) ?? [];
    const run = history[0];
    if (!run) {
      return {
        caseId: record.id,
        status: 'not_run',
        safetyCritical: record.safetyCritical,
        currentPasses: 0,
        requiredPasses: record.requiredPasses,
        reason: 'This production case has not been replayed.',
        latestRunId: null,
      };
    }
    const currentFingerprint = currentFingerprints.get(record.adapterId);
    const isCurrent = (candidate: PlaygroundProductionEvaluationRun): boolean =>
      candidate.caseRevision === record.revision
      && candidate.adapterVersion === record.adapterVersion
      && candidate.promptFingerprint === record.promptFingerprint
      && candidate.configuration.fingerprint === currentFingerprint;
    if (!isCurrent(run)) {
      return {
        caseId: record.id,
        status: 'stale',
        safetyCritical: record.safetyCritical,
        currentPasses: 0,
        requiredPasses: record.requiredPasses,
        reason: 'The fixture, production prompt/parser, or model configuration changed after this replay.',
        latestRunId: run.id,
      };
    }
    let currentPasses = 0;
    for (const candidate of history) {
      if (!isCurrent(candidate) || candidate.status !== 'passed') break;
      currentPasses += 1;
    }
    if (run.status === 'passed' && currentPasses < record.requiredPasses) {
      return {
        caseId: record.id,
        status: 'insufficient',
        safetyCritical: record.safetyCritical,
        currentPasses,
        requiredPasses: record.requiredPasses,
        reason: `${currentPasses} of ${record.requiredPasses} consecutive current passes; replay to prove stability.`,
        latestRunId: run.id,
      };
    }
    return {
      caseId: record.id,
      status: run.status,
      safetyCritical: record.safetyCritical,
      currentPasses,
      requiredPasses: record.requiredPasses,
      reason: run.status === 'passed'
        ? `The current production path passed every deterministic check ${currentPasses} consecutive times.`
        : run.status === 'cancelled'
          ? 'The replay was cancelled before it could prove the current path.'
          : run.error ?? 'One or more deterministic checks failed.',
      latestRunId: run.id,
    };
  });
  const passed = results.filter((result) => result.status === 'passed').length;
  const unresolved = results.filter((result) => result.status !== 'passed');
  const blockers = unresolved.filter((result) => result.safetyCritical).length;
  const warnings = unresolved.length - blockers;
  return {
    status: blockers > 0 ? 'blocked' : warnings > 0 || cases.length === 0 ? 'incomplete' : 'ready',
    total: cases.length,
    passed,
    blockers,
    warnings,
    stale: results.filter((result) => result.status === 'stale').length,
    notRun: results.filter((result) => result.status === 'not_run').length,
    insufficient: results.filter((result) => result.status === 'insufficient').length,
    cases: results,
  };
}

function activeKey(ownerId: string, caseId: string): string {
  return `${ownerId}\u0000${caseId}`;
}

function boundedPrompt(prompt: string): string {
  if (prompt.length > MAX_PLAYGROUND_PROMPT_CHARS) {
    throw badRequest(
      `the production prompt is ${prompt.length.toLocaleString()} characters; keep the fixture below ${MAX_PLAYGROUND_PROMPT_CHARS.toLocaleString()}`,
    );
  }
  return prompt;
}

function promptFingerprint(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 20);
}

function compactError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 500) || 'production evaluation failed';
}
