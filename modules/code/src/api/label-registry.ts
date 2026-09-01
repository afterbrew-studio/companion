/**
 * The target repository's `.github/labels.json` is the only vocabulary a
 * writer may apply. Live GitHub pagination still contains leftovers the
 * registry has already marked retiring, so those names must never be minted
 * from model output.
 */

export type LabelScope = 'issue' | 'pr' | 'both';
export type LabelStatus = 'active' | 'retiring';

export interface RegistryEntry {
  readonly name: string;
  readonly scope: LabelScope;
  readonly status: LabelStatus;
}

export class LabelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelRegistryError';
  }
}

/** Families a filer, template, or classifier owns. Model output must not apply these. */
const FILER_PREFIXES = [
  'complexity:',
  'tier:',
  'state:',
  'model:',
  'area:',
  'feature:',
  'review:',
] as const;

export function isFilerFamily(name: string): boolean {
  if (/^P[0-3]$/.test(name)) return true;
  if (name === 'agent:ready' || name === 'agent-ready') return true;
  if (name === 'bug') return true;
  return FILER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function parseLabelRegistry(text: string): RegistryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new LabelRegistryError('label registry is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { labels?: unknown }).labels)) {
    throw new LabelRegistryError('label registry is missing a labels array');
  }
  const labels = (parsed as { labels: unknown[] }).labels;
  const entries: RegistryEntry[] = [];
  for (const row of labels) {
    if (!row || typeof row !== 'object') continue;
    const name = (row as { name?: unknown }).name;
    const scope = (row as { scope?: unknown }).scope;
    const status = (row as { status?: unknown }).status;
    if (typeof name !== 'string' || name.trim() === '') continue;
    if (scope !== 'issue' && scope !== 'pr' && scope !== 'both') continue;
    if (status !== 'active' && status !== 'retiring') continue;
    entries.push({ name, scope, status });
  }
  return entries;
}

export type RegistrySource = {
  repo(fullName: string): Promise<{ default_branch: string }>;
  repoTextFiles(fullName: string, ref: string, paths: readonly string[]): Promise<Map<string, string>>;
};

export async function loadLabelRegistry(source: RegistrySource, fullName: string): Promise<RegistryEntry[]> {
  const { default_branch } = await source.repo(fullName);
  const files = await source.repoTextFiles(fullName, default_branch, ['.github/labels.json']);
  const text = files.get('.github/labels.json');
  if (typeof text !== 'string' || text.trim() === '') {
    throw new LabelRegistryError(`label registry missing for ${fullName}`);
  }
  return parseLabelRegistry(text);
}

export function allowedNames(entries: readonly RegistryEntry[], namespace: 'issue' | 'pr'): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    if (entry.scope === 'both' || entry.scope === namespace) names.add(entry.name);
  }
  return names;
}

/**
 * Names a model (or pipeline step) asked to apply, minus anything the
 * registry does not currently allow in this namespace and minus filer-owned
 * families. An empty result means addLabels must not be called.
 */
export function filterProposedLabels(
  proposed: readonly string[],
  entries: readonly RegistryEntry[],
  namespace: 'issue' | 'pr',
): string[] {
  const allowed = allowedNames(entries, namespace);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of proposed) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (isFilerFamily(name)) continue;
    if (!allowed.has(name)) continue;
    kept.push(name);
  }
  return kept;
}

/** Labels that describe the work itself and travel from issue onto the PR. */
export function copyBothScopeLabels(
  issueLabels: readonly string[],
  entries: readonly RegistryEntry[],
): string[] {
  const both = new Set(
    entries.filter((entry) => entry.status === 'active' && entry.scope === 'both').map((entry) => entry.name),
  );
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of issueLabels) {
    const name = raw.trim();
    if (!name || seen.has(name) || !both.has(name)) continue;
    seen.add(name);
    kept.push(name);
  }
  return kept;
}

export function labelNames(labels: ReadonlyArray<{ name?: string } | string> | undefined): string[] {
  if (!labels) return [];
  return labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))).filter(Boolean);
}
