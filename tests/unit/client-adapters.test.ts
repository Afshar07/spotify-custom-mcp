import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { buildGenericStdioConfig } from '../../src/clients/generic-config.js';
import { OpenCodeAdapter } from '../../src/clients/opencode-adapter.js';
import { EClientConflictPolicy, EClientDetection } from '../../src/models/client-adapter.js';

const EXE = 'C:\\Users\\Friend\\AppData\\Local\\Programs\\SpotifyCurator\\spotify-curator.exe';

const JSONC = `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight", // keep me
  "mcp": {
    "other": { "type": "local", "command": ["other-mcp"], },
  },
}
`;

async function fixture(initial?: string, extra: Partial<ConstructorParameters<typeof OpenCodeAdapter>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'curator-oc-'));
  const configPath = join(root, 'cfg', 'opencode.jsonc');
  await mkdir(join(root, 'cfg'), { recursive: true });
  if (initial !== undefined) await writeFile(configPath, initial);
  const adapter = new OpenCodeAdapter({ env: { PATH: '' }, home: root, backupDir: join(root, 'backups'), ...extra });
  return { root, configPath, adapter, options: { executablePath: EXE, configPath } };
}

describe('OpenCodeAdapter install', () => {
  it('adds the entry, keeps comments and unrelated settings, and backs up first', async () => {
    const { adapter, configPath, options, root } = await fixture(JSONC);
    const result = await adapter.install(options);
    const text = await readFile(configPath, 'utf8');
    expect(result.changed).toBe(true);
    expect(text).toContain('// my settings');
    expect(text).toContain('// keep me');
    const config = parse(text);
    expect(config.theme).toBe('tokyonight');
    expect(config.mcp.other.command).toEqual(['other-mcp']);
    expect(config.mcp['spotify-curator']).toEqual({ type: 'local', command: [EXE, 'mcp'], enabled: true });
    expect(await readFile(result.backupPath!, 'utf8')).toBe(JSONC);
    expect(await readdir(join(root, 'backups'))).toHaveLength(1);
  });

  it('is idempotent: a second install changes nothing and makes no new backup', async () => {
    const { adapter, configPath, options, root } = await fixture(JSONC);
    await adapter.install(options);
    const once = await readFile(configPath, 'utf8');
    const second = await adapter.install(options);
    expect(second.changed).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe(once);
    expect(await readdir(join(root, 'backups'))).toHaveLength(1);
  });

  it('creates the config when none exists', async () => {
    const { adapter, configPath, options } = await fixture();
    const result = await adapter.install(options);
    expect(result.backupPath).toBeNull();
    expect(parse(await readFile(configPath, 'utf8')).mcp['spotify-curator'].command[0]).toBe(EXE);
  });

  it('refuses to touch a file it cannot parse', async () => {
    const { adapter, configPath, options } = await fixture('{ "mcp": { oops ');
    await expect(adapter.install(options)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(configPath, 'utf8')).toBe('{ "mcp": { oops ');
    expect((await adapter.inspect(configPath)).valid).toBe(false);
  });

  it('aborts on a conflicting Spotify entry by default, and disables (not deletes) it on request', async () => {
    const initial = JSON.stringify({ mcp: { 'spotify-playlists': { type: 'local', command: ['node', '/x/spotify-custom-mcp/dist/server.js'] } } });
    const { adapter, configPath, options } = await fixture(initial);
    expect((await adapter.inspect(configPath)).conflicts).toEqual(['spotify-playlists']);
    await expect(adapter.install(options)).rejects.toThrow(/another Spotify server/);
    expect(await readFile(configPath, 'utf8')).toBe(initial);

    const result = await adapter.install({ ...options, conflictPolicy: EClientConflictPolicy.Disable });
    expect(result.disabledConflicts).toEqual(['spotify-playlists']);
    const config = parse(await readFile(configPath, 'utf8'));
    expect(config.mcp['spotify-playlists'].enabled).toBe(false);
    expect(config.mcp['spotify-playlists'].command).toEqual(['node', '/x/spotify-custom-mcp/dist/server.js']);
  });

  it('keeps user extras (like timeout) on our entry when repairing it', async () => {
    const initial = JSON.stringify({ mcp: { 'spotify-curator': { type: 'local', command: ['old.exe'], timeout: 9000 } } });
    const { adapter, configPath, options } = await fixture(initial);
    await adapter.install(options);
    expect(parse(await readFile(configPath, 'utf8')).mcp['spotify-curator']).toMatchObject({ command: [EXE, 'mcp'], timeout: 9000, enabled: true });
  });

  it('rolls back when the written file is corrupt', async () => {
    const { adapter, configPath, options } = await fixture(JSONC, {
      writeFile: async (path) => writeFile(path, '{ broken'),
    });
    await expect(adapter.install(options)).rejects.toThrow(/original settings were restored/);
    expect(await readFile(configPath, 'utf8')).toBe(JSONC);
  });

  it('rolls back when unrelated settings would change', async () => {
    const { adapter, configPath, options } = await fixture(JSONC, {
      writeFile: async (path) =>
        writeFile(path, JSON.stringify({ mcp: { 'spotify-curator': { type: 'local', command: [EXE, 'mcp'], enabled: true } } })),
    });
    await expect(adapter.install(options)).rejects.toThrow(/restored/);
    expect(await readFile(configPath, 'utf8')).toBe(JSONC);
  });

  it('removes a newly created file on rollback', async () => {
    const { adapter, configPath, options } = await fixture(undefined, { writeFile: async (path) => writeFile(path, 'nope') });
    await expect(adapter.install(options)).rejects.toThrow();
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });
});

describe('OpenCodeAdapter inspect / repair / uninstall / verify', () => {
  it('detects a broken entry and repairs it', async () => {
    const { adapter, configPath, options } = await fixture(JSONC);
    await adapter.install(options);
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('spotify-curator.exe', 'gone.exe'));
    const broken = await adapter.inspect(configPath, [EXE, 'mcp']);
    expect(broken).toMatchObject({ registered: true, upToDate: false });
    await adapter.install(options);
    expect(await adapter.inspect(configPath, [EXE, 'mcp'])).toMatchObject({ registered: true, upToDate: true });
  });

  it('repairs a disabled entry', async () => {
    const { adapter, configPath, options } = await fixture(JSONC);
    await adapter.install(options);
    await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('"enabled": true', '"enabled": false'));
    expect((await adapter.inspect(configPath)).upToDate).toBe(false);
    await adapter.install(options);
    expect((await adapter.inspect(configPath)).upToDate).toBe(true);
  });

  it('uninstall removes only our entry and keeps everything else', async () => {
    const { adapter, configPath, options } = await fixture(JSONC);
    await adapter.install(options);
    await adapter.uninstall();
    const text = await readFile(configPath, 'utf8');
    const config = parse(text);
    expect(config.mcp['spotify-curator']).toBeUndefined();
    expect(config.mcp.other).toBeDefined();
    expect(text).toContain('// keep me');
    await adapter.uninstall(); // idempotent
  });

  it('reports a missing OpenCode installation', async () => {
    const { adapter } = await fixture();
    const result = await adapter.detect();
    expect(result.installed).toBe(EClientDetection.NotFound);
  });

  it('detects OpenCode on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-bin-'));
    await writeFile(join(root, process.platform === 'win32' ? 'opencode.exe' : 'opencode'), '');
    const adapter = new OpenCodeAdapter({ env: { PATH: root }, home: root, backupDir: join(root, 'b') });
    expect((await adapter.detect()).installed).toBe(EClientDetection.Installed);
  });

  it('verify runs the configured command through an MCP handshake, and reports failures plainly', async () => {
    const { adapter, options } = await fixture(JSONC, { handshake: async () => ({ serverName: 's', serverVersion: '1', toolNames: ['a', 'b'] }) });
    await adapter.install(options);
    expect(await adapter.verify()).toMatchObject({ ok: true, toolCount: 2 });

    const failing = await fixture(JSONC, { handshake: async () => { throw new Error('spawn ENOENT\nstack'); } });
    await failing.adapter.install(failing.options);
    const result = await failing.adapter.verify();
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)!.detail).toContain('spawn ENOENT');
  });

  it('verify fails when not registered', async () => {
    const { adapter } = await fixture(JSONC);
    await adapter.install({ executablePath: EXE, configPath: (await adapter.inspect()).configPath! }).catch(() => undefined);
    const clean = await fixture('{}');
    expect((await clean.adapter.verify()).ok).toBe(false);
  });
});

describe('Generic MCP configuration', () => {
  it('generic fallback config uses stdio with the mcp argument', () => {
    expect(JSON.parse(buildGenericStdioConfig(EXE)).mcpServers['spotify-curator']).toEqual({ command: EXE, args: ['mcp'] });
  });
});
