import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

// Run `npm run build:exe` first. CI sets REQUIRE_STANDALONE=1 so a missing build fails instead of skipping.
const exe = resolve('build', process.platform === 'win32' ? 'spotify-curator.exe' : 'spotify-curator');
const available = existsSync(exe);
if (!available && process.env.REQUIRE_STANDALONE === '1') throw new Error(`Standalone build missing: ${exe}`);

describe.skipIf(!available)('standalone executable (no Node.js on PATH)', () => {
  const emptyPathEnv = async () => ({ PATH: '', Path: '', SPOTIFY_CURATOR_DATA_DIR: await mkdtemp(join(tmpdir(), 'curator-exe-')) });

  it('reports its version without Node installed', async () => {
    const env = await emptyPathEnv();
    expect(execFileSync(exe, ['version'], { env, encoding: 'utf8' }).trim()).toBe('0.3.0');
  }, 30_000); // Allow cold-start executable scanning on Windows, as for the MCP startup checks.

  it('serves MCP over stdio with clean stdout, lists all tools, and fails safely without Spotify auth', async () => {
    const env = await emptyPathEnv();
    const transport = new StdioClientTransport({ command: exe, args: ['mcp'], env, stderr: 'pipe' });
    const client = new Client({ name: 'standalone-test', version: '0' });
    const errors: Error[] = [];
    client.onerror = (e) => errors.push(e);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(28);
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_tracks', 'generate_playlist', 'get_playlist_summary']));
      // Read-only tool with no credentials: must be a friendly error, never a Spotify mutation or crash.
      const result = await client.callTool({ name: 'search_tracks', arguments: { query: 'anything' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/not set up yet/);
      expect(errors).toEqual([]); // nothing but JSON-RPC on stdout
    } finally {
      await client.close();
    }
  }, 30_000);

  it('does not open the setup wizard when started as an MCP server', async () => {
    const env = await emptyPathEnv();
    const transport = new StdioClientTransport({ command: exe, args: ['mcp'], env: { ...env, BROWSER: '/nonexistent' }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (c) => (stderr += String(c)));
    const client = new Client({ name: 'standalone-test', version: '0' });
    await client.connect(transport);
    await client.close();
    expect(stderr).not.toMatch(/Setup is open|127\.0\.0\.1/);
  }, 30_000);

  it('status works and never prints secrets', async () => {
    const env = await emptyPathEnv();
    const out = execFileSync(exe, ['status', '--json'], { env, encoding: 'utf8' });
    expect(JSON.parse(out).version).toBe('0.3.0');
    expect(out).not.toMatch(/refresh|access_token|secret/i);
  });

  it('registers the standalone executable for desktop and verifies its tools without Node on PATH', async () => {
    const baseEnv = await emptyPathEnv();
    const configDir = join(baseEnv.SPOTIFY_CURATOR_DATA_DIR, 'codex');
    const env = { ...baseEnv, CODEX_HOME: configDir };
    const output = execFileSync(exe, ['install-chatgpt', '--json'], { env, encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ changed: true, verified: true, toolCount: 28 });
    const config = await readFile(join(configDir, 'config.toml'), 'utf8');
    expect(config).not.toMatch(/refresh|access_token|secret/i);
    expect(JSON.parse(execFileSync(exe, ['status', '--json'], { env, encoding: 'utf8' })).chatgpt)
      .toMatchObject({ registered: true, upToDate: true });
    expect(JSON.parse(execFileSync(exe, ['install-chatgpt', '--json'], { env, encoding: 'utf8' })).changed).toBe(false);
    execFileSync(exe, ['cleanup', '--chatgpt'], { env });
    expect(JSON.parse(execFileSync(exe, ['status', '--json'], { env, encoding: 'utf8' })).chatgpt.registered).toBe(false);
  }, 30_000);

  it('cleans requested local settings even when the desktop config prevents entry removal', async () => {
    const baseEnv = await emptyPathEnv();
    const configDir = join(baseEnv.SPOTIFY_CURATOR_DATA_DIR, 'codex');
    await mkdir(configDir);
    const malformed = 'model = "unterminated';
    await writeFile(join(configDir, 'config.toml'), malformed);
    await writeFile(join(baseEnv.SPOTIFY_CURATOR_DATA_DIR, 'settings.json'), '{}');
    const result = spawnSync(exe, ['cleanup', '--chatgpt', '--settings', '--credentials'], { env: { ...baseEnv, CODEX_HOME: configDir }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(existsSync(join(baseEnv.SPOTIFY_CURATOR_DATA_DIR, 'settings.json'))).toBe(false);
    expect(await readFile(join(configDir, 'config.toml'), 'utf8')).toBe(malformed);
  });
});
