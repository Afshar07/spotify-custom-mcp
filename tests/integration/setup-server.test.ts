import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContext } from '../../src/setup/app-context.js';
import { startSetupServer, type ISetupServer } from '../../src/setup/setup-server.js';
import { CLIENT_ID, MemoryCredentialStore, createFakeSpotify, fakeBrowser } from '../helpers/auth-fakes.js';

const EXE = '/opt/curator/spotify-curator';
let server: ISetupServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function boot(handshake?: () => Promise<{ serverName: string; serverVersion: string; toolNames: string[] }>) {
  const root = await mkdtemp(join(tmpdir(), 'curator-setup-'));
  const store = new MemoryCredentialStore();
  const spotify = createFakeSpotify();
  const browser = fakeBrowser('approve');
  const app = new AppContext({
    env: { SPOTIFY_CURATOR_DATA_DIR: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'cfg'), PATH: '' },
    home: root,
    executablePath: EXE,
    createStore: () => store,
    fetch: spotify.fetch,
    openBrowser: async (url) => {
      // Use an ephemeral callback port to avoid clashes between tests.
      const patched = new URL(url);
      return browser.openBrowser(patched.toString());
    },
    handshake: handshake ?? (async () => ({ serverName: 'spotify-custom-mcp', serverVersion: '0.3.0', toolNames: ['search_tracks', 'generate_playlist', 'x'] })),
  });
  server = await startSetupServer(app);
  const base = new URL(server.url);
  const origin = base.origin;
  const secret = base.searchParams.get('t')!;
  const cookie = `sc=${secret}`;
  const call = (path: string, body?: unknown) =>
    fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, store, root, origin, secret, cookie, call };
}

describe('setup server security', () => {
  it('serves the page only with the per-run token and sets a strict cookie + CSP', async () => {
    const { origin, secret } = await boot();
    expect((await fetch(origin + '/')).status).toBe(403);
    const ok = await fetch(`${origin}/?t=${secret}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await ok.text()).toContain('Connect Spotify');
  });

  it('rejects API calls without the cookie, with a foreign Origin, or a rebound Host', async () => {
    const { origin, cookie } = await boot();
    expect((await fetch(origin + '/api/state')).status).toBe(403);
    const foreign = await fetch(origin + '/api/disconnect', { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: '{}' });
    expect(foreign.status).toBe(403);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port: new URL(origin).port, path: '/api/state', headers: { Host: 'evil.example', cookie } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(400);
  });
});

describe('setup server flow (mock Spotify, mock handshake)', () => {
  it('validates and saves the Client ID, connects through PKCE, then reports connected', async () => {
    const { call, store, root } = await boot();
    expect((await call('/api/client-id', { clientId: 'short' })).status).toBe(400);
    expect((await call('/api/client-id', { clientId: CLIENT_ID })).status).toBe(200);
    const settings = JSON.parse(await readFile(join(root, 'data', 'settings.json'), 'utf8'));
    expect(settings).toEqual({ clientId: CLIENT_ID, redirectPort: 8888 });

    // Use a free port for the loopback listener in this test.
    await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({ clientId: CLIENT_ID, redirectPort: 0 }));
    expect((await call('/api/connect', {})).status).toBe(202);
    let job: any;
    for (let i = 0; i < 50; i += 1) {
      job = await (await call('/api/job')).json();
      if (job.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job.state).toBe('done');
    expect(job.account.displayName).toBe('Test Listener');
    expect(store.value?.refreshToken).toBe('refresh-initial');

    const state = await (await call('/api/state')).json();
    expect(state.auth.state).toBe('connected');
    expect(JSON.stringify(state)).not.toContain('refresh-initial');

    expect((await call('/api/disconnect', {})).status).toBe(200);
    expect(store.value).toBeNull();
  });

  it('registers both local desktop clients and reports verified only after the handshake', async () => {
    const { call, root } = await boot();
    const result = await (await call('/api/install', { clients: ['opencode', 'chatgpt-desktop'] })).json();
    expect(result.opencode).toMatchObject({ installed: true, verified: true, toolCount: 3 });
    expect(result['chatgpt-desktop']).toMatchObject({ installed: true, verified: true, toolCount: 3 });
    const desktop = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
    expect(desktop).toContain('spotify-curator');
    expect(JSON.stringify((await (await call('/api/state')).json()).clients)).not.toMatch(/unverified/i);
    const config = JSON.parse(await readFile(join(root, 'cfg', 'opencode', 'opencode.json'), 'utf8'));
    expect(config.mcp['spotify-curator'].command).toEqual([EXE, 'mcp']);
    expect(JSON.stringify(config)).not.toMatch(/token|secret/i);
  });

  it('does not claim success when the program fails to start', async () => {
    const { call } = await boot(async () => {
      throw new Error('spawn ENOENT');
    });
    const result = await (await call('/api/install', { clients: ['opencode', 'chatgpt-desktop'] })).json();
    expect(result.opencode).toMatchObject({ installed: true, verified: false });
    expect(result['chatgpt-desktop']).toMatchObject({ installed: true, verified: false });
  });

  it('runs diagnostics where registration passes but missing Spotify auth is still a failure', async () => {
    const { call } = await boot();
    await call('/api/install', { clients: ['opencode', 'chatgpt-desktop'] });
    const report = await (await call('/api/diagnostics', {})).json();
    const byId = Object.fromEntries(report.checks.map((c: any) => [c.id, c]));
    expect(byId.opencode.status).toBe('pass');
    expect(byId.credentials.status).toBe('fail');
    expect(byId.refresh.status).toBe('skipped');
    expect(byId['spotify-api'].status).toBe('skipped');
    expect(byId.chatgpt.status).toBe('pass');
    expect(report.ok).toBe(false);
  });

  it('repair re-creates a broken OpenCode entry', async () => {
    const { call, root } = await boot();
    await call('/api/install', { clients: ['opencode'] });
    const path = join(root, 'cfg', 'opencode', 'opencode.json');
    await writeFile(path, '{ "mcp": {} }');
    expect((await (await call('/api/repair', {})).json()).ok).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).mcp['spotify-curator'].command).toEqual([EXE, 'mcp']);
  });
});
