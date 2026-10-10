import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
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
  });

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
});
