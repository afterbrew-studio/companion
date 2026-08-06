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
  test <id> --model <id>     One real round trip: does it answer, and can it
                             call a tool? Records what it observed.

Options:
  --api-version <v>          Azure only: the version the resource serves
  --yes                      Skip the remove confirmation (required when piped)
  --json                     Machine-readable output
  --home <path>              Data directory (default: COMPANION_HOME or ~/.companion)
  --host <host> --port <n>   Address of the running daemon

Requires the runtime module: companion module install runtime
`;

export interface ProviderCommand {
  readonly action: 'list' | 'add' | 'remove' | 'test';
  readonly id?: string;
  readonly kind?: string;
  readonly url?: string;
  readonly key?: string;
  readonly apiVersion?: string;
  readonly models: readonly string[];
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
}

const ACTIONS = ['list', 'add', 'remove', 'test'] as const;

export function parseProviderCommand(argv: readonly string[]): ProviderCommand {
  const action = ACTIONS.find((a) => a === argv[0]);
  if (!action) throw new Error(`Unknown provider command: ${argv[0] ?? '(none)'}\n\n${PROVIDER_HELP}`);
  const models: string[] = [];
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
          }${provider.baseUrl ? `  ${provider.baseUrl}` : ''}`,
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
