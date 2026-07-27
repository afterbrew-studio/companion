import { createPrivateKey, createSign } from 'node:crypto';

/**
 * GitHub App authentication: the app proves itself with a short-lived JWT signed
 * by its private key, then exchanges that for an INSTALLATION token scoped to
 * one organisation's selected repositories.
 *
 * This exists because a personal access token is not an option everywhere. An
 * organisation on GitHub Enterprise Cloud with SAML SSO must SSO-authorise each
 * token, and one that bans PATs outright cannot connect at all. There is no
 * configuration workaround; it needs a different credential.
 *
 * No dependency: RS256 is `node:crypto` plus base64url, which is the whole of
 * the signing side. A JWT library here would be a supply-chain surface for
 * thirty lines.
 */

/** GitHub rejects anything over 10 minutes, and clock skew eats the rest. */
const JWT_TTL_S = 9 * 60;

export interface InstallationToken {
  readonly token: string;
  /** Epoch ms. GitHub issues these for an hour. */
  readonly expiresAt: number;
}

export class GitHubAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

/**
 * A signed app JWT. `iat` is backdated a minute because GitHub rejects a token
 * issued in the future, and a daemon whose clock runs slightly fast would
 * otherwise fail every mint with an error that says nothing about clocks.
 */
export function appJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + JWT_TTL_S, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new GitHubAppError('the private key is not a valid PEM (download it again from the app settings)', 400);
  }
  return `${header}.${payload}.${signer.sign(key, 'base64url')}`;
}

/** Exchange the app JWT for an installation token. */
export async function mintInstallationToken(
  api: string,
  appId: string,
  installationId: string,
  privateKeyPem: string,
): Promise<InstallationToken> {
  const res = await fetch(`${api}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: appHeaders(appJwt(appId, privateKeyPem)),
  });
  if (!res.ok) throw new GitHubAppError(await describe(res, 'minting an installation token'), res.status);
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) throw new GitHubAppError('GitHub returned no installation token', 502);
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/**
 * Which account the installation belongs to.
 *
 * An installation has no `GET /user`: there is no viewer, which is the one place
 * an app genuinely differs from a PAT in this codebase. The login comes from the
 * installation's own `account` instead, so the rest of the registry keeps
 * working unchanged.
 */
export async function installationLogin(
  api: string,
  appId: string,
  installationId: string,
  privateKeyPem: string,
): Promise<string> {
  const res = await fetch(`${api}/app/installations/${encodeURIComponent(installationId)}`, {
    headers: appHeaders(appJwt(appId, privateKeyPem)),
  });
  if (!res.ok) throw new GitHubAppError(await describe(res, 'reading the installation'), res.status);
  const body = (await res.json()) as { account?: { login?: string; slug?: string } };
  const login = body.account?.login ?? body.account?.slug;
  if (!login) throw new GitHubAppError('the installation reported no account login', 502);
  return login;
}

const appHeaders = (jwt: string): Record<string, string> => ({
  authorization: `Bearer ${jwt}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'companion-daemon',
});

/**
 * GitHub's app errors are the ones an operator will actually hit, so name the
 * likely cause rather than echoing a status code.
 */
async function describe(res: Response, what: string): Promise<string> {
  const body = (await res.text()).slice(0, 200);
  if (res.status === 401) return `${what} failed: GitHub rejected the app credentials (wrong App ID, or the private key does not belong to this app)`;
  if (res.status === 404) return `${what} failed: no such installation (check the Installation ID, and that the app is still installed)`;
  return `${what} failed (${res.status}): ${body}`;
}
