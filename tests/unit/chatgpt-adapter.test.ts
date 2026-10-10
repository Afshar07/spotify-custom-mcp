import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatGptDesktopAdapter } from '../../src/clients/chatgpt-adapter.js';
import { EClientConflictPolicy } from '../../src/models/client-adapter.js';

const EXE = 'C:\\Program Files\\SpotifyCurator\\spotify-curator.exe';
const ORIGINAL = '# Keep my preferences\nmodel = "gpt-6"\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp" # keep this too\n';

async function fixture(initial?: string, failWrite = false, failHandshake = false) {
  const root = await mkdtemp(join(tmpdir(), 'curator-gpt-'));
  const configPath = join(root, '.codex', 'config.toml');
  await mkdir(join(root, '.codex'), { recursive: true });
  if (initial !== undefined) await writeFile(configPath, initial);
  const adapter = new ChatGptDesktopAdapter({
    home: root, env: {}, backupDir: join(root, 'backups'), expectedCommand: [EXE, 'mcp'],
    writeFile: failWrite ? async (path, data) => { await writeFile(path, data); throw new Error('disk failed'); } : undefined,
    handshake: async (command) => {
      if (command[0] !== EXE || command[1] !== 'mcp') throw new Error('wrong launch command');
      if (failHandshake) throw new Error('spawn failed');
      return { serverName: 'spotify-custom-mcp', serverVersion: '0.3.0', toolNames: ['search_tracks'] };
    },
  });
  return { adapter, root, configPath, options: { executablePath: EXE } };
}

describe('ChatGPT desktop registration', () => {
  it('preserves existing settings and comments, backs up, verifies and installs idempotently', async () => {
    const { adapter, configPath, options } = await fixture(ORIGINAL);
    const result = await adapter.install(options);
    expect(await readFile(result.backupPath!, 'utf8')).toBe(ORIGINAL);
    const installed = await readFile(configPath, 'utf8');
    for (const line of ORIGINAL.trim().split('\n').filter(Boolean)) expect(installed).toContain(line);
    expect(await adapter.inspect()).toMatchObject({ valid: true, registered: true, upToDate: true, command: [EXE, 'mcp'] });
    expect(await adapter.verify()).toMatchObject({ ok: true, toolCount: 1 });
    expect((await adapter.install(options)).changed).toBe(false);
    await adapter.uninstall();
    expect(await adapter.inspect()).toMatchObject({ registered: false });
    expect(await readFile(configPath, 'utf8')).toContain(ORIGINAL.trim());
  });

  it('creates a missing config with no credentials', async () => {
    const { adapter, configPath, options } = await fixture();
    expect((await adapter.install(options)).backupPath).toBeNull();
    expect((await adapter.inspect()).command).toEqual([EXE, 'mcp']);
    expect(await readFile(configPath, 'utf8')).not.toMatch(/token|secret/);
  });

  it('refuses malformed TOML without changing it', async () => {
    const { adapter, configPath, options } = await fixture('model = "unterminated');
    expect((await adapter.inspect()).valid).toBe(false);
    await expect(adapter.install(options)).rejects.toThrow(/TOML/);
    expect(await readFile(configPath, 'utf8')).toBe('model = "unterminated');
  });

  it('restores the exact original after a failed write', async () => {
    const { adapter, configPath, options } = await fixture(ORIGINAL, true);
    await expect(adapter.install(options)).rejects.toThrow(/restored/);
    expect(await readFile(configPath, 'utf8')).toBe(ORIGINAL);
  });

  it('aborts on conflicting Spotify servers or explicitly disables them', async () => {
    const initial = ORIGINAL + '\n[mcp_servers.spotify-old]\ncommand = "old-server"\n';
    const { adapter, configPath, options } = await fixture(initial);
    await expect(adapter.install(options)).rejects.toThrow(/another Spotify/);
    expect(await readFile(configPath, 'utf8')).toBe(initial);
    expect((await adapter.install({ ...options, conflictPolicy: EClientConflictPolicy.Disable })).disabledConflicts).toEqual(['spotify-old']);
    expect(await readFile(configPath, 'utf8')).toContain('enabled = false');
    expect((await adapter.install(options)).changed).toBe(false);
  });

  it('preserves per-tool policies when repairing a disabled stale entry', async () => {
    const { adapter, configPath, options } = await fixture(ORIGINAL + '\n[mcp_servers.spotify-curator]\ncommand = "old"\nenabled = false\nstartup_timeout_sec = 30\n[mcp_servers.spotify-curator.tools.search_tracks]\napproval_mode = "prompt"\n');
    await adapter.install(options);
    expect((await adapter.inspect()).upToDate).toBe(true);
    const text = await readFile(configPath, 'utf8');
    expect(text).toContain('startup_timeout_sec = 30');
    expect(text).toContain('approval_mode = "prompt"');
  });

  it('reports handshake failure without claiming that registration proves startup', async () => {
    const { adapter, options } = await fixture(undefined, false, true);
    await adapter.install(options);
    expect(await adapter.verify()).toMatchObject({ ok: false, toolCount: null });
  });

  it('uses CODEX_HOME instead of the default configuration folder', async () => {
    const { root } = await fixture();
    const adapter = new ChatGptDesktopAdapter({ home: root, env: { CODEX_HOME: join(root, 'custom') }, backupDir: join(root, 'backups') });
    const result = await adapter.install({ executablePath: EXE });
    expect(result.configPath).toBe(join(root, 'custom', 'config.toml'));
  });

  it('removes a newly created config when its write fails', async () => {
    const { adapter, configPath, options } = await fixture(undefined, true);
    await expect(adapter.install(options)).rejects.toThrow(/restored/);
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reveal credentials from malformed TOML in errors', async () => {
    const { adapter, options } = await fixture('secret = "private-value"\nbroken = [');
    const error = await adapter.install(options).catch((error: Error) => error);
    if (!(error instanceof Error)) throw new Error('Malformed settings unexpectedly installed');
    expect(error.message).not.toContain('private-value');
    expect((await adapter.inspect()).problems.join(' ')).not.toContain('private-value');
  });

  it('refuses to remove a registration replaced by another program', async () => {
    const { adapter, configPath, options } = await fixture();
    await adapter.install(options);
    const replacement = '[mcp_servers.spotify-curator]\ncommand = "other-server"\n';
    await writeFile(configPath, replacement);
    await expect(adapter.uninstall()).rejects.toThrow(/different program/);
    expect(await readFile(configPath, 'utf8')).toBe(replacement);
  });
});
