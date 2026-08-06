import { apiClient } from './client.js';

/**
 * Model providers from the terminal.
 *
 * It exists so the two ways of giving this instance a runtime feel the same. A
 * CLI runtime is fixed with a command (`claude auth login`), and before this the
 * built-in one could only be fixed by finding a page, which made one of the two
 * paths second-class in exactly the place an operator meets it: the "not ready"
 * hint on a machine.
 *
 * It is also the headless path. A container is configured by environment and
 * commands, not by clicking, and an air-gapped install has no browser session to
 * click with.
 */

export const PROVIDER_HELP = `Usage: companion provider <command> [options]

  list                       Configured model providers and their models
  add <label> --kind <k> [--url <u>] [--key <k>] [--model <id>]...
                             Add an endpoint. --kind is anthropic, openai, azure
                             or openai-compatible. Repeat --model per model id
                             (on azure these are deployment names).
  remove <id> [--yes]        Delete a provider and its stored credential
  models <id>                Ask the endpoint which models it serves, and adopt
                             the ones this instance does not have yet
  test <id> --model <id>     One real round trip: does it answer, and can it
                             call a tool? Records what it observed.

Options:
  --workspace <id>           Limit this provider to a workspace (repeat for
                             several). Omitted means every workspace may use it.
  --api-version <v>          Azure only: the version the resource serves
  --yes                      Skip the remove confirmation (required when piped)
  --json                     Machine-readable output
  --home <path>              Data directory (default: COMPANION_HOME or ~/.companion)
  --host <host> --port <n>   Address of the running daemon

Requires the runtime module: companion module install runtime
`;

export interface ProviderCommand {
  readonly action: 'list' | 'add' | 'remove' | 'test' | 'models';
  readonly id?: string;
  readonly kind?: string;
  readonly url?: string;
  readonly key?: string;
  readonly apiVersion?: string;
  readonly models: readonly string[];
  readonly workspaces: readonly string[];
  readonly json: boolean;
  readonly yes: boolean;
}

interface ModelRow {
  readonly id: string;
  readonly inputPerMTok: number | null;
  readonly outputPerMTok: number | null;
  readonly probed: { readonly ok: boolean; readonly tools: boolean } | null;
}

interface ProviderRow {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly baseUrl: string | null;
  readonly hasKey: boolean;
  readonly enabled: boolean;
  readonly models: readonly ModelRow[];
  /** null = every workspace; a list = only those. Mirrors how runners scope. */
  readonly workspaceIds: readonly string[] | null;
}

const ACTIONS = ['list', 'add', 'remove', 'test', 'models'] as const;

export function parseProviderCommand(argv: readonly string[]): ProviderCommand {
  const action = ACTIONS.find((a) => a === argv[0]);
  if (!action) throw new Error(`Unknown provider command: ${argv[0] ?? '(none)'}\n\n${PROVIDER_HELP}`);
  const models: string[] = [];
  const workspaces: string[] = [];
  let id: string | undefined;
  let kind: string | undefined;
  let url: string | undefined;
  let key: string | undefined;
  let apiVersion: string | undefined;
  let json = false;
  let yes = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--json') json = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--kind') kind = next();
    else if (arg === '--url') url = next();
    else if (arg === '--key') key = next();
    else if (arg === '--api-version') apiVersion = next();
    else if (arg === '--model') models.push(next());
    else if (arg === '--workspace') workspaces.push(next());
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}\n\n${PROVIDER_HELP}`);
    else if (id === undefined) id = arg;
    else throw new Error(`Unexpected argument: ${arg}\n\n${PROVIDER_HELP}`);
  }

  return {
    action,
    ...(id === undefined ? {} : { id }),
    ...(kind === undefined ? {} : { kind }),
    ...(url === undefined ? {} : { url }),
    ...(key === undefined ? {} : { key }),
    ...(apiVersion === undefined ? {} : { apiVersion }),
    models,
    workspaces,
    json,
    yes,
  };
}

export async function runProviderCommand(command: ProviderCommand, baseUrl: string): Promise<void> {
  const api = apiClient(baseUrl);
  const out = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  switch (command.action) {
    case 'list': {
      const { providers } = await api<{ providers: ProviderRow[] }>('GET', '/api/model-providers');
      if (command.json) return out(JSON.stringify(providers, null, 2));
      if (providers.length === 0) {
        return out('No model providers. Add one: companion provider add "My endpoint" --kind anthropic --key …');
      }
      for (const provider of providers) {
        out(
          `${provider.id}  ${provider.label}  [${provider.kind}]  ${provider.enabled ? 'enabled' : 'disabled'}  ${
            provider.hasKey ? 'key set' : 'NO KEY'
          }${provider.baseUrl ? `  ${provider.baseUrl}` : ''}  ${
            provider.workspaceIds ? `workspaces: ${provider.workspaceIds.join(', ')}` : 'shared'
          }`,
        );
        for (const model of provider.models) {
          const price =
            model.inputPerMTok === null || model.outputPerMTok === null
              ? 'unpriced'
              : `$${model.inputPerMTok}/$${model.outputPerMTok} per Mtok`;
          const probe = !model.probed ? 'not tested' : model.probed.ok ? (model.probed.tools ? 'tools work' : 'no tool calling') : 'failed';
          out(`    ${model.id}  (${price}, ${probe})`);
        }
      }
      return;
    }

    case 'add': {
      if (!command.id) throw new Error(`Which provider? Usage: companion provider add <label> --kind <kind>`);
      if (!command.kind) throw new Error('--kind is required (anthropic, openai, azure, openai-compatible)');
      const { provider } = await api<{ provider: ProviderRow }>('POST', '/api/model-providers', {
        label: command.id,
        kind: command.kind,
        baseUrl: command.url ?? null,
        ...(command.key ? { apiKey: command.key } : {}),
        ...(command.apiVersion ? { apiVersion: command.apiVersion } : {}),
        models: command.models.map((id) => ({ id })),
        workspaceIds: command.workspaces.length > 0 ? command.workspaces : null,
      });
      if (command.json) return out(JSON.stringify(provider, null, 2));
      out(`added ${provider.id} (${provider.kind})`);
      if (!provider.hasKey) out('No credential stored. Re-run with --key, or add it under Settings.');
      if (provider.models.length === 0) out('No models yet. Add them with --model <id>.');
      return;
    }

    case 'remove': {
      if (!command.id) throw new Error('Which provider? Usage: companion provider remove <id>');
      if (!command.yes && !process.stdout.isTTY) {
        throw new Error('Refusing to remove a provider unattended without --yes');
      }
      await api<{ ok: true }>('DELETE', `/api/model-providers/${encodeURIComponent(command.id)}`);
      return out(`removed ${command.id}`);
    }

    case 'models': {
      if (!command.id) throw new Error('Which provider? Usage: companion provider models <id>');
      const { models: found } = await api<{ models: string[] }>(
        'GET',
        `/api/model-providers/${encodeURIComponent(command.id)}/available-models`,
      );
      if (command.json) return out(JSON.stringify(found, null, 2));
      const { providers } = await api<{ providers: ProviderRow[] }>('GET', '/api/model-providers');
      const current = providers.find((p) => p.id === command.id);
      if (!current) throw new Error('provider not found');
      const known = new Set(current.models.map((m) => m.id));
      const fresh = found.filter((id) => !known.has(id));
      if (fresh.length === 0) return out(`${found.length} model(s) offered, all already configured`);
      // Adopted rather than merely printed: an id nobody added is an id nothing
      // can run, and the operator still disables what they do not want.
      await api('PATCH', `/api/model-providers/${encodeURIComponent(command.id)}`, {
        models: [
          ...current.models,
          ...fresh.map((id) => ({ id, label: null, contextWindow: null, inputPerMTok: null, outputPerMTok: null, probed: null, options: null })),
        ],
      });
      return out(`added ${fresh.length} model(s):\n    ${fresh.join('\n    ')}`);
    }

    case 'test': {
      if (!command.id) throw new Error('Which provider? Usage: companion provider test <id> --model <id>');
      const model = command.models[0];
      if (!model) throw new Error('--model is required');
      const { result } = await api<{ result: { model: string; probe: { ok: boolean; tools: boolean; detail: string | null } } }>(
        'POST',
        `/api/model-providers/${encodeURIComponent(command.id)}/probe`,
        { model },
      );
      if (command.json) return out(JSON.stringify(result, null, 2));
      if (!result.probe.ok) return out(`FAILED  ${result.model}: ${result.probe.detail ?? 'no answer'}`);
      return out(
        result.probe.tools
          ? `OK  ${result.model} answered and called a tool`
          : `PARTIAL  ${result.model} answered but did not call a tool: it can serve prompt-only work only`,
      );
    }
  }
}

/**
 * First run: give the built-in runtime a model, inline.
 *
 * Only asked when that runtime is present and the ONE thing missing is a
 * credential, which is exactly the state its detection reports as `installed`.
 * Every other runtime is fixed with its own command in a terminal; this is the
 * equivalent, in the place the operator already is.
 */
export async function offerBuiltinProvider(baseUrl: string, token: string, interactive: boolean): Promise<void> {
  if (!interactive) return;
  const api = apiClient(baseUrl, token);
  const existing = await api<{ providers: ProviderRow[] }>('GET', '/api/model-providers').catch(() => null);
  // No route means the runtime module is not installed, which is not a problem
  // to explain: this instance runs an installed CLI instead. A provider that is
  // already configured is not a question either.
  if (!existing || existing.providers.length > 0) return;

  const { confirm, input, password, select } = await import('@inquirer/prompts');
  process.stdout.write(
    '\nThe built-in runtime is here but has no model to call. It uses a key you supply, and nothing leaves this machine except the model request itself.\n',
  );
  if (!(await confirm({ message: 'Add one now?', default: true }))) {
    process.stdout.write('Skipped. Add one later with: companion provider add\n');
    return;
  }

  const kind = await select({
    message: 'Which endpoint?',
    choices: [
      { value: 'anthropic', name: 'Anthropic API' },
      { value: 'openai', name: 'OpenAI API' },
      { value: 'azure', name: 'Azure OpenAI / AI Foundry' },
      { value: 'openai-compatible', name: 'An OpenAI-compatible gateway (LiteLLM, vLLM, OpenRouter, …)' },
    ],
  });
  const needsUrl = kind === 'openai-compatible' || kind === 'azure';
  const endpoint = needsUrl
    ? await input({ message: 'Endpoint URL', validate: (v) => /^https?:\/\//i.test(v.trim()) || 'an http(s) URL' })
    : '';
  const apiVersion = kind === 'azure' ? await input({ message: 'API version the resource serves' }) : '';
  const apiKey = await password({ message: 'API key', mask: '*' });
  const model = await input({
    message: kind === 'azure' ? 'Deployment name' : 'Model id',
    validate: (v) => v.trim().length > 0 || 'required',
  });

  try {
    const { provider } = await api<{ provider: ProviderRow }>('POST', '/api/model-providers', {
      label: kind,
      kind,
      baseUrl: endpoint.trim() === '' ? null : endpoint.trim(),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(apiVersion.trim() === '' ? {} : { apiVersion: apiVersion.trim() }),
      models: [{ id: model.trim() }],
    });
    // Detect rather than assume: one real round trip answers the question the
    // operator asked by filling this in at all, which is whether agent work can
    // run here now.
    const { result } = await api<{ result: { probe: { ok: boolean; tools: boolean; detail: string | null } } }>(
      'POST',
      `/api/model-providers/${encodeURIComponent(provider.id)}/probe`,
      { model: model.trim() },
    );
    if (!result.probe.ok) {
      process.stdout.write(`Saved, but the test call failed: ${result.probe.detail ?? 'no answer'}\n`);
    } else if (!result.probe.tools) {
      process.stdout.write('Saved. It answers but does not call tools, so it can serve prompt-only work only.\n');
    } else {
      process.stdout.write(`Saved and tested: ${model.trim()} answers and calls tools.\n`);
    }
  } catch (err) {
    process.stderr.write(`Could not save the provider: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
