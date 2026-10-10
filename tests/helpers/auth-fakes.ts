import type { ICredentialStore, ISecretProtector, IStoredCredentials } from '../../src/models/auth.js';
import { REQUESTED_SCOPES } from '../../src/scopes.js';

export const CLIENT_ID = 'a'.repeat(32);

export class MemoryCredentialStore implements ICredentialStore {
  public value: IStoredCredentials | null = null;
  public failSave = false;
  public failLoad = false;
  public saves = 0;
  public async load(): Promise<IStoredCredentials | null> {
    if (this.failLoad) throw new Error('store offline');
    return this.value ? structuredClone(this.value) : null;
  }
  public async save(credentials: IStoredCredentials): Promise<void> {
    if (this.failSave) throw new Error('store offline');
    this.saves += 1;
    this.value = structuredClone(credentials);
  }
  public async delete(): Promise<void> {
    this.value = null;
  }
}

/** Reversible "encryption" keyed by a fake Windows user, to model per-user DPAPI isolation. */
export class FakeUserProtector implements ISecretProtector {
  public constructor(private readonly user: string) {}
  public async protect(plaintext: string): Promise<string> {
    return Buffer.from(`${this.user}|${Buffer.from(plaintext).toString('base64')}`).toString('base64');
  }
  public async unprotect(protectedText: string): Promise<string> {
    const [user, body] = Buffer.from(protectedText, 'base64').toString().split('|');
    if (user !== this.user) throw new Error('wrong user');
    return Buffer.from(body, 'base64').toString();
  }
}

export interface IRecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams | null;
}

export interface IFakeSpotifyOptions {
  tokenStatus?: number;
  tokenError?: string;
  grantedScopes?: string[];
  rotateRefresh?: boolean;
  meStatus?: number;
  refreshError?: string;
}

/** Fake accounts.spotify.com + /me. Records requests; never touches the network. */
export function createFakeSpotify(options: IFakeSpotifyOptions = {}) {
  const requests: IRecordedRequest[] = [];
  let refreshCount = 0;
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body instanceof URLSearchParams ? init.body : null;
    requests.push({ url, method: init.method ?? 'GET', headers, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (url.endsWith('/api/token')) {
      const grant = body?.get('grant_type');
      if (grant === 'refresh_token') {
        refreshCount += 1;
        if (options.refreshError) return json(400, { error: options.refreshError });
        return json(200, {
          access_token: `access-${refreshCount}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: (options.grantedScopes ?? [...REQUESTED_SCOPES]).join(' '),
          ...(options.rotateRefresh ? { refresh_token: `rotated-${refreshCount}` } : {}),
        });
      }
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return json(options.tokenStatus, { error: options.tokenError ?? 'invalid_grant' });
      }
      return json(200, {
        access_token: 'access-initial',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-initial',
        scope: (options.grantedScopes ?? [...REQUESTED_SCOPES]).join(' '),
      });
    }
    if (url.endsWith('/v1/me')) {
      if (options.meStatus && options.meStatus !== 200) return json(options.meStatus, { error: { message: 'nope' } });
      return json(200, { id: 'user-1', display_name: 'Test Listener' });
    }
    return json(404, {});
  }) as typeof fetch;
  return { fetch: fetchImpl, requests, refreshCount: () => refreshCount };
}

/** Simulates the browser: follows the authorize URL straight to the redirect with the given outcome. */
export function fakeBrowser(outcome: 'approve' | 'deny' | 'wrong-state' | 'none' = 'approve') {
  const urls: string[] = [];
  const openBrowser = async (authorizeUrl: string) => {
    urls.push(authorizeUrl);
    if (outcome === 'none') return;
    const url = new URL(authorizeUrl);
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    const state = outcome === 'wrong-state' ? 'attacker' : url.searchParams.get('state')!;
    if (outcome === 'deny') redirect.searchParams.set('error', 'access_denied');
    else redirect.searchParams.set('code', 'auth-code-123');
    redirect.searchParams.set('state', state);
    setTimeout(() => void fetch(redirect).catch(() => undefined), 10);
  };
  return { openBrowser, urls };
}
