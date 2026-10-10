import { describe, expect, it } from 'vitest';
import { SpotifyAuthService } from '../../src/auth/spotify-auth-service.js';
import { deriveCodeChallenge } from '../../src/auth/pkce.js';
import { EAuthErrorCode, EAuthState } from '../../src/models/auth.js';
import { REQUESTED_SCOPES } from '../../src/scopes.js';
import {
  CLIENT_ID,
  MemoryCredentialStore,
  createFakeSpotify,
  fakeBrowser,
  type IFakeSpotifyOptions,
} from '../helpers/auth-fakes.js';

function setup(options: IFakeSpotifyOptions = {}, outcome: Parameters<typeof fakeBrowser>[0] = 'approve') {
  const spotify = createFakeSpotify(options);
  const store = new MemoryCredentialStore();
  const browser = fakeBrowser(outcome);
  const service = new SpotifyAuthService({
    clientId: CLIENT_ID,
    redirectPort: 0,
    store,
    fetch: spotify.fetch,
    openBrowser: browser.openBrowser,
  });
  return { spotify, store, browser, service };
}

describe('SpotifyAuthService.authorize', () => {
  it('runs the PKCE flow: S256 challenge, state, verifier exchange without a client secret', async () => {
    const { spotify, store, browser, service } = setup();
    const account = await service.authorize({ timeoutMs: 3_000 });

    const authorize = new URL(browser.urls[0]);
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorize.searchParams.get('scope')!.split(' ')).toEqual([...REQUESTED_SCOPES]);

    const exchange = spotify.requests.find((r) => r.body?.get('grant_type') === 'authorization_code')!;
    expect(deriveCodeChallenge(exchange.body!.get('code_verifier')!)).toBe(authorize.searchParams.get('code_challenge'));
    expect(exchange.body!.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'));
    expect(exchange.headers.authorization).toBeUndefined();
    expect(exchange.body!.has('client_secret')).toBe(false);

    expect(account).toEqual({ id: 'user-1', displayName: 'Test Listener' });
    expect(store.value?.refreshToken).toBe('refresh-initial');
    expect(await service.getStatus()).toMatchObject({ state: EAuthState.Connected, account });
  });

  it('rejects an implausible Client ID before opening a browser', async () => {
    const spotify = createFakeSpotify();
    const service = new SpotifyAuthService({ clientId: 'nope', store: new MemoryCredentialStore(), fetch: spotify.fetch });
    await expect(service.authorize()).rejects.toMatchObject({ code: EAuthErrorCode.InvalidClientId });
    expect(spotify.requests).toHaveLength(0);
  });

  it('maps invalid_client from Spotify to a Client ID message and stores nothing', async () => {
    const { store, service } = setup({ tokenStatus: 400, tokenError: 'invalid_client' });
    await expect(service.authorize({ timeoutMs: 3_000 })).rejects.toMatchObject({ code: EAuthErrorCode.InvalidClientId });
    expect(store.value).toBeNull();
  });

  it('reports cancelled authorization', async () => {
    const { store, service } = setup({}, 'deny');
    await expect(service.authorize({ timeoutMs: 3_000 })).rejects.toMatchObject({ code: EAuthErrorCode.Cancelled });
    expect(store.value).toBeNull();
  });

  it('reports expiry when the browser never calls back, exposing a fallback link', async () => {
    const { service } = setup({}, 'none');
    let link = '';
    await expect(service.authorize({ timeoutMs: 40, onAuthorizeUrl: (url) => (link = url) })).rejects.toMatchObject({
      code: EAuthErrorCode.Expired,
    });
    expect(link).toContain('code_challenge=');
  });

  it('ignores a forged callback with the wrong state', async () => {
    const { store, service } = setup({}, 'wrong-state');
    await expect(service.authorize({ timeoutMs: 150 })).rejects.toMatchObject({ code: EAuthErrorCode.Expired });
    expect(store.value).toBeNull();
  });

  it('refuses a grant that is missing scopes', async () => {
    const { store, service } = setup({ grantedScopes: ['user-library-read'] });
    await expect(service.authorize({ timeoutMs: 3_000 })).rejects.toMatchObject({ code: EAuthErrorCode.MissingScopes });
    expect(store.value).toBeNull();
  });

  it('explains Development Mode when Spotify answers 403 for the account, and stores nothing', async () => {
    const { store, service } = setup({ meStatus: 403 });
    const error = await service.authorize({ timeoutMs: 3_000 }).catch((e) => e);
    expect(error.code).toBe(EAuthErrorCode.AccountNotAllowed);
    expect(error.message).toMatch(/User management/);
    expect(store.value).toBeNull();
  });

  it('does not claim success when the credential cannot be stored', async () => {
    const { store, service } = setup();
    store.failSave = true;
    await expect(service.authorize({ timeoutMs: 3_000 })).rejects.toMatchObject({ code: EAuthErrorCode.TokenStorageFailed });
    expect((await service.getStatus()).state).toBe(EAuthState.NotConnected);
  });
});

describe('SpotifyAuthService runtime tokens', () => {
  const stored = { refreshToken: 'refresh-1', scopes: [...REQUESTED_SCOPES], obtainedAt: 'now' };

  it('refreshes with client_id only, caches the access token, and reports scopes', async () => {
    const { spotify, store, service } = setup();
    store.value = { ...stored };
    const first = await service.getAccessToken();
    const second = await service.getAccessToken();
    expect(second).toBe(first);
    expect(spotify.refreshCount()).toBe(1);
    const request = spotify.requests[0];
    expect(request.body!.get('client_id')).toBe(CLIENT_ID);
    expect(request.headers.authorization).toBeUndefined();
    expect(first.scopes).toEqual([...REQUESTED_SCOPES]);
  });

  it('persists a rotated refresh token', async () => {
    const { store, service } = setup({ rotateRefresh: true });
    store.value = { ...stored };
    await service.getAccessToken();
    expect(store.value?.refreshToken).toBe('rotated-1');
  });

  it('still returns an access token if persisting the rotation fails, without leaking secrets to logs', async () => {
    const logs: string[] = [];
    const spotify = createFakeSpotify({ rotateRefresh: true });
    const store = new MemoryCredentialStore();
    store.value = { ...stored };
    store.failSave = true;
    const service = new SpotifyAuthService({ clientId: CLIENT_ID, store, fetch: spotify.fetch, log: (m) => logs.push(m) });
    await expect(service.getAccessToken()).resolves.toMatchObject({ accessToken: 'access-1' });
    expect(logs.join(' ')).toMatch(/could not be saved/);
    expect(logs.join(' ')).not.toMatch(/rotated-1|refresh-1|access-1/);
  });

  it('shares a single refresh between concurrent callers', async () => {
    const { spotify, store, service } = setup({ rotateRefresh: true });
    store.value = { ...stored };
    await Promise.all([service.getAccessToken(), service.getAccessToken(), service.getAccessToken()]);
    expect(spotify.refreshCount()).toBe(1);
  });

  it('retries with a token another process already rotated', async () => {
    const spotify = createFakeSpotify();
    let rejectedOnce = false;
    const store = new MemoryCredentialStore();
    store.value = { ...stored };
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (!rejectedOnce && init?.body instanceof URLSearchParams && init.body.get('refresh_token') === 'refresh-1') {
        rejectedOnce = true;
        store.value = { ...stored, refreshToken: 'refresh-2' }; // sibling process rotated it
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return spotify.fetch(url, init);
    }) as typeof fetch;
    const service = new SpotifyAuthService({ clientId: CLIENT_ID, store, fetch: fetchImpl });
    await expect(service.getAccessToken()).resolves.toMatchObject({ accessToken: 'access-1' });
  });

  it('asks the user to reconnect when Spotify rejects the refresh token', async () => {
    const { store, service } = setup({ refreshError: 'invalid_grant' });
    store.value = { ...stored };
    await expect(service.getAccessToken()).rejects.toMatchObject({ code: EAuthErrorCode.ReauthorizationRequired });
  });

  it('explains when nothing is connected or the store is unreadable', async () => {
    const { store, service } = setup();
    await expect(service.getAccessToken()).rejects.toMatchObject({ code: EAuthErrorCode.NotConnected });
    store.failLoad = true;
    await expect(service.getAccessToken()).rejects.toMatchObject({ code: EAuthErrorCode.CredentialsUnreadable });
    expect((await service.getStatus()).state).toBe(EAuthState.Unreadable);
  });

  it('disconnect deletes credentials and clears the cached token', async () => {
    const { spotify, store, service } = setup();
    store.value = { ...stored };
    await service.getAccessToken();
    await service.disconnect();
    expect(store.value).toBeNull();
    await expect(service.getAccessToken()).rejects.toMatchObject({ code: EAuthErrorCode.NotConnected });
    expect(spotify.refreshCount()).toBe(1);
  });
});
