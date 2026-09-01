/**
 * Start Octopus through its authenticated CLI, which is the only source this
 * fork's review flow accepts (`source: "adapter"`). Applying `review:octopus`
 * and waiting for a webhook never starts a review here.
 */

export interface OctopusStartRequest {
  readonly baseUrl: string;
  readonly token: string;
  readonly remoteUrl: string;
  readonly prNumber: number;
  readonly correlationId: string;
  readonly fetch?: typeof fetch;
}

export interface OctopusStartResult {
  readonly repoId: string;
  readonly prNumber: number;
}

export function octopusAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; token: string } | null {
  const baseUrl = (env.COMPANION_OCTOPUS_URL ?? env.OCTOPUS_URL ?? '').replace(/\/+$/, '');
  const token = env.COMPANION_OCTOPUS_TOKEN ?? env.OCTOPUS_TOKEN ?? '';
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export async function startOctopusReview(request: OctopusStartRequest): Promise<OctopusStartResult> {
  const fetchImpl = request.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${request.token}`,
    Accept: 'application/json',
  };
  const lookup = await fetchImpl(
    `${request.baseUrl}/api/cli/repos/by-remote?url=${encodeURIComponent(request.remoteUrl)}`,
    { headers },
  );
  if (!lookup.ok) {
    throw new Error(`octopus repo lookup failed (${lookup.status})`);
  }
  const found = (await lookup.json()) as { id?: string };
  if (typeof found.id !== 'string' || found.id === '') {
    throw new Error('octopus repo lookup returned no id');
  }
  const started = await fetchImpl(`${request.baseUrl}/api/cli/repos/${found.id}/review`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prNumber: request.prNumber,
      correlationId: request.correlationId,
    }),
  });
  if (!started.ok) {
    throw new Error(`octopus review start failed (${started.status})`);
  }
  return { repoId: found.id, prNumber: request.prNumber };
}
