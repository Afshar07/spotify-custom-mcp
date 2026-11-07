import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from '@decimalturn/toml-patch';
import { describe, expect, it } from 'vitest';
import { legacyMcpEnvironment, PluginInstaller } from '../../src/plugin/installer.js';

async function fixture(fail = false) {
  const home = await mkdtemp(join(tmpdir(), 'curator-plugin-'));
  const config = join(home, '.codex', 'config.toml');
  await mkdir(join(home, '.codex'), { recursive: true });
  const original = 'model = "keep-me"\n[mcp_servers.spotify-curator]\ncommand = "old-curator"\nargs = ["mcp"]\n[mcp_servers.spotify-curator.env]\nSPOTIFY_REFRESH_TOKEN = "test-private-token"\n[mcp_servers.other]\ncommand = "keep-other"\n';
  await writeFile(config, original);
  const installer = new PluginInstaller({ home, env: {}, dataDir: join(home, 'data'), executablePath: '/apps/spotify-curator',
    sourceDir: resolve('plugins/spotify-curator'),
    handshake: async () => { if (fail) throw new Error('startup failed'); return { serverName: 'spotify-custom-mcp', serverVersion: '0.3.0', toolNames: ['get_history_status', 'set_playlist_cover', 'generate_playlist'] }; },
  });
  return { home, installer, config, original };
}
describe('one-click plugin upgrade', () => {
  it('preserves unrelated settings and private credentials, enables plugin, disables legacy only after verification', async () => {
    const { installer, config, home } = await fixture();
    const result = await installer.install();
    const document = parse(await readFile(config, 'utf8')) as any;
    expect(document.model).toBe('keep-me');
    expect(document.mcp_servers.other.command).toBe('keep-other');
    expect(document.mcp_servers['spotify-curator'].enabled).toBe(false);
    expect(document.mcp_servers['spotify-curator'].env.SPOTIFY_REFRESH_TOKEN).toBe('test-private-token');
    expect(document.plugins['spotify-curator@spotify-curator-local'].enabled).toBe(true);
    const mcp = await readFile(join(result.pluginPath, 'mcp.json'), 'utf8');
    expect(mcp).not.toContain('test-private-token');
    expect(mcp).toContain('plugin-mcp');
    const marketplace = JSON.parse(await readFile(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    expect(marketplace.plugins).toHaveLength(1);
    await installer.install();
    expect(JSON.parse(await readFile(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8')).plugins).toHaveLength(1);
  });
  it('does not disable the old MCP or register a plugin when verification fails', async () => {
    const { installer, config, original } = await fixture(true);
    await expect(installer.install()).rejects.toThrow(/verify|start/i);
    expect(await readFile(config, 'utf8')).toBe(original);
  });
  it('keeps another marketplace and its plugins, and preserves concurrent changes on rollback', async () => {
    const { installer, home, config } = await fixture();
    await mkdir(join(home, '.agents', 'plugins'), { recursive: true });
    const path = join(home, '.agents', 'plugins', 'marketplace.json');
    await writeFile(path, JSON.stringify({ name: 'my-local', plugins: [{ name: 'other', source: { source: 'local', path: './other' } }] }));
    await installer.install();
    expect(JSON.parse(await readFile(path, 'utf8')).plugins.map((p: any) => p.name)).toEqual(['other', 'spotify-curator']);
    await writeFile(config, (await readFile(config, 'utf8')) + '\n# newer edit\n');
    await expect(installer.rollback()).rejects.toThrow(/changed/);
    expect(await readFile(config, 'utf8')).toContain('newer edit');
  });
  it('can undo an upgrade without removing the Spotify sign-in', async () => {
    const { installer, config, original } = await fixture();
    await installer.install();
    await installer.install(); // Repeated clicks preserve the original rollback snapshot.
    await installer.rollback();
    expect(await readFile(config, 'utf8')).toBe(original);
  });
  it('reuses private legacy environment values at runtime rather than copying them into the plugin', async () => {
    const { installer, config } = await fixture();
    await installer.install();
    const env = await legacyMcpEnvironment(config, 'spotify-curator', { KEEP: 'kept' });
    expect(env.KEEP).toBe('kept');
    expect(env.SPOTIFY_REFRESH_TOKEN).toBe('test-private-token');
  });
  it('recovers a lock left by an exited migration process', async () => {
    const { installer, home } = await fixture();
    await mkdir(join(home, 'data'), { recursive: true });
    await writeFile(join(home, 'data', 'plugin-migration.lock'), '2147483647');
    await expect(installer.install()).resolves.toMatchObject({ restartRequired: true });
  });
  it('unregisters only this plugin on uninstall', async () => {
    const { installer, config, home } = await fixture();
    await installer.install();
    await installer.uninstall();
    const document = parse(await readFile(config, 'utf8')) as any;
    expect(document.plugins['spotify-curator@spotify-curator-local']).toBeUndefined();
    expect(document.mcp_servers.other.command).toBe('keep-other');
    expect(JSON.parse(await readFile(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8')).plugins).toHaveLength(0);
  });
  it('preserves inherited legacy variables through an encrypted private file and passes them to verification', async () => {
    const { config, home } = await fixture();
    await writeFile(config, '[mcp_servers.spotify-curator]\ncommand="old"\nenv_vars=["SPOTIFY_REFRESH_TOKEN"]\n');
    const protector = { protect: async (text: string) => Buffer.from(text).toString('base64'), unprotect: async (blob: string) => Buffer.from(blob, 'base64').toString() };
    let verifiedToken: string | undefined;
    const installer = new PluginInstaller({ home, env: { SPOTIFY_REFRESH_TOKEN: 'test-inherited-private' }, dataDir: join(home, 'data'),
      sourceDir: resolve('plugins/spotify-curator'), executablePath: '/apps/spotify-curator', protector,
      handshake: async (_command, options) => { verifiedToken = options?.env?.SPOTIFY_REFRESH_TOKEN; return { serverName: 'spotify-custom-mcp', serverVersion: '0.4.0', toolNames: ['generate_playlist', 'get_history_status', 'set_playlist_cover'] }; } });
    const installed = await installer.install();
    expect(verifiedToken).toBe('test-inherited-private');
    const mcp = JSON.parse(await readFile(join(installed.pluginPath, 'mcp.json'), 'utf8'));
    expect(JSON.stringify(mcp)).not.toContain('test-inherited-private');
    const env = await legacyMcpEnvironment(config, 'spotify-curator', mcp.mcpServers['spotify-curator'].env, protector);
    expect(env.SPOTIFY_REFRESH_TOKEN).toBe('test-inherited-private');
  });
});
