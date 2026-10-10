import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveSettings } from '../../src/auth/settings.js';
import { createRuntimeSpotifyClient } from '../../src/runtime.js';
import { APP_VERSION } from '../../src/version.js';
import { REQUESTED_SCOPES } from '../../src/scopes.js';
import { CLIENT_ID, MemoryCredentialStore, createFakeSpotify } from '../helpers/auth-fakes.js';

describe('runtime credential selection', () => {
  it('explains how to set up when nothing is configured (server still starts)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'curator-rt-'));
    const client = await createRuntimeSpotifyClient({ env: { SPOTIFY_CURATOR_DATA_DIR: dir } });
    await expect(client.getCurrentUser()).rejects.toThrow(/not set up yet/);
  });

  it('uses PKCE credentials from the secure store and calls Spotify with the bearer token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'curator-rt-'));
    await saveSettings(dir, { clientId: CLIENT_ID, redirectPort: 8888 });
    const store = new MemoryCredentialStore();
    store.value = { refreshToken: 'r1', scopes: [...REQUESTED_SCOPES], obtainedAt: 'now' };
    const spotify = createFakeSpotify({ rotateRefresh: true });
    const client = await createRuntimeSpotifyClient({ env: { SPOTIFY_CURATOR_DATA_DIR: dir }, createStore: () => store, fetch: spotify.fetch });
    const user = await client.getCurrentUser();
    expect(user.id).toBe('user-1');
    const api = spotify.requests.find((r) => r.url.endsWith('/v1/me'))!;
    expect(api.headers.authorization).toBe('Bearer access-1');
    expect(store.value?.refreshToken).toBe('rotated-1'); // rotation persisted
  });

  it('keeps existing env-var installs working', async () => {
    const spotify = createFakeSpotify();
    const client = await createRuntimeSpotifyClient({
      env: { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret', SPOTIFY_REFRESH_TOKEN: 'rt' },
      fetch: spotify.fetch,
    });
    await client.getCurrentUser();
    expect(spotify.requests[0].headers.authorization).toMatch(/^Basic /);
  });

  it('turns an unreadable store into a friendly message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'curator-rt-'));
    await saveSettings(dir, { clientId: CLIENT_ID, redirectPort: 8888 });
    const store = new MemoryCredentialStore();
    store.failLoad = true;
    const client = await createRuntimeSpotifyClient({ env: { SPOTIFY_CURATOR_DATA_DIR: dir }, createStore: () => store });
    await expect(client.getCurrentUser()).rejects.toThrow(/could not be read/);
  });
});

describe('version metadata', () => {
  it('matches package.json', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });
});
