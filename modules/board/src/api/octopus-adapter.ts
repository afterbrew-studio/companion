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
  readonly headSha?: string;
  readonly fetch?: typeof fetch;
}

export interface OctopusStartResult {
  readonly repoId: string;
  readonly prNumber: number;
}

export function octopusAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; token: string; login: string | null } | null {
  const baseUrl = (env.COMPANION_OCTOPUS_URL ?? env.OCTOPUS_URL ?? '').replace(/\/+$/, '');
  const token = env.COMPANION_OCTOPUS_TOKEN ?? env.OCTOPUS_TOKEN ?? '';
  if (!baseUrl || !token) return null;
  return { baseUrl, token, login: octopusLogin(env) };
}

/**
 * Which GitHub login Octopus reviews as, or null when nobody has said.
 *
 * Read separately from `octopusAdapterConfig`, which needs a URL and a token. Whether
 * Octopus is this flow's reviewer is knowable without being able to reach it, and folding
 * the two together meant an unconfigured adapter could not answer the question at all -
 * so a flow that nominated a person still collected a "waiting for Octopus" blocker.
 *
 * Absent means "cannot tell", which the gate answers permissively: a deployment that has
 * not set this must not silently lose the reviews it was getting.
 */
export function octopusLogin(env: NodeJS.ProcessEnv = process.env): string | null {
  return (env.COMPANION_OCTOPUS_LOGIN ?? '').trim() || null;
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
      ...(request.headSha ? { headSha: request.headSha } : {}),
    }),
  });
  if (!started.ok) {
    throw new Error(`octopus review start failed (${started.status})`);
  }
  return { repoId: found.id, prNumber: request.prNumber };
}
