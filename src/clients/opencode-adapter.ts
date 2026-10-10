import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { access } from 'node:fs/promises';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { writeFileAtomic } from '../auth/settings.js';
import {
  EClientConflictPolicy,
  EClientDetection,
  EClientSupport,
  type IClientConfiguration,
  type IClientDetectionResult,
  type IInstallOptions,
  type IInstallResult,
  type IMcpClientAdapter,
  type IVerificationResult,
} from '../models/client-adapter.js';
import { performMcpHandshake } from './mcp-handshake.js';

export const DEFAULT_ENTRY_NAME = 'spotify-curator';
const FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' };
const MAX_BACKUPS = 10;

export interface IOpenCodeAdapterDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Directory for config backups (outside the client's config folder). */
  backupDir: string;
  writeFile?: (path: string, data: string) => Promise<void>;
  handshake?: typeof performMcpHandshake;
  entryName?: string;
}

interface IMcpEntry {
  type?: string;
  command?: unknown;
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * Registers Spotify Curator as a local MCP server in OpenCode's JSON/JSONC config:
 *   "mcp": { "<name>": { "type": "local", "command": [exe, "mcp"], "enabled": true } }
 * (shape per OpenCode's MCP servers docs, read via search results; see .ai/opencode-integration.md).
 */
export class OpenCodeAdapter implements IMcpClientAdapter {
  public readonly id = 'opencode';
  public readonly name = 'OpenCode';
  public readonly support = EClientSupport.Supported;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly entryName: string;
  private readonly writeFile: (path: string, data: string) => Promise<void>;
  private readonly handshake: typeof performMcpHandshake;
  private lastConfigPath: string | null = null;

  public constructor(private readonly deps: IOpenCodeAdapterDeps) {
    this.env = deps.env ?? process.env;
    this.home = deps.home ?? homedir();
    this.entryName = deps.entryName ?? DEFAULT_ENTRY_NAME;
    this.writeFile = deps.writeFile ?? writeFileAtomic;
    this.handshake = deps.handshake ?? performMcpHandshake;
  }

  /** Global config candidates, most specific first. OpenCode merges .json and .jsonc. */
  public candidatePaths(): string[] {
    const base = this.env.XDG_CONFIG_HOME ?? join(this.home, '.config');
    const dir = join(base, 'opencode');
    return [join(dir, 'opencode.jsonc'), join(dir, 'opencode.json')];
  }

  private async resolveConfigPath(override?: string): Promise<{ path: string; exists: boolean }> {
    if (override) return { path: override, exists: await exists(override) };
    if (this.lastConfigPath) return { path: this.lastConfigPath, exists: await exists(this.lastConfigPath) };
    for (const candidate of this.candidatePaths()) {
      if (await exists(candidate)) return { path: candidate, exists: true };
    }
    return { path: this.candidatePaths()[1], exists: false };
  }

  public async detect(): Promise<IClientDetectionResult> {
    const binary = await this.findBinary();
    const config = await this.resolveConfigPath();
    if (binary) {
      return { installed: EClientDetection.Installed, support: this.support, detail: 'OpenCode was found on this PC.', configPath: config.path };
    }
    const configDir = this.candidatePaths()[0].replace(/[\\/][^\\/]+$/, '');
    if (await exists(configDir)) {
      return { installed: EClientDetection.Unknown, support: this.support, detail: 'OpenCode settings exist, but the program was not found on PATH. You can still set it up.', configPath: config.path };
    }
    return { installed: EClientDetection.NotFound, support: this.support, detail: 'OpenCode was not found. Install OpenCode first, or set it up anyway and it will work once OpenCode is installed.', configPath: config.path };
  }

  private async findBinary(): Promise<string | null> {
    const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode.bat'] : ['opencode'];
    const dirs = (this.env.PATH ?? this.env.Path ?? '').split(delimiter).filter(Boolean);
    dirs.push(join(this.home, '.opencode', 'bin'));
    if (this.env.APPDATA) dirs.push(join(this.env.APPDATA, 'npm'));
    for (const dir of dirs) {
      for (const name of names) {
        if (await exists(join(dir, name))) return join(dir, name);
      }
    }
    return null;
  }

  public async inspect(overridePath?: string, expectedCommand?: string[]): Promise<IClientConfiguration> {
    const { path, exists: present } = await this.resolveConfigPath(overridePath);
    const base: IClientConfiguration = {
      configPath: path, configExists: present, valid: true, registered: false, upToDate: false, command: null, conflicts: [], problems: [],
    };
    if (!present) return base;
    const parsed = this.parseConfig(await readFile(path, 'utf8'));
    if (!parsed.ok) return { ...base, valid: false, problems: [parsed.problem] };
    const servers = asRecord(parsed.value.mcp);
    const ours = servers[this.entryName] as IMcpEntry | undefined;
    if (ours) {
      base.registered = true;
      base.command = Array.isArray(ours.command) ? ours.command.map(String) : null;
      base.upToDate = !!base.command && ours.enabled !== false && (!expectedCommand || sameCommand(base.command, expectedCommand));
      if (!base.upToDate) base.problems.push(ours.enabled === false ? 'The Spotify Curator entry is switched off in OpenCode.' : 'The Spotify Curator entry points to a different program.');
    }
    base.conflicts = findConflicts(servers, this.entryName);
    return base;
  }

  public async install(options: IInstallOptions): Promise<IInstallResult> {
    const { path, exists: present } = await this.resolveConfigPath(options.configPath);
    const entryName = options.entryName ?? this.entryName;
    const original = present ? await readFile(path, 'utf8') : '{\n}\n';
    const parsed = this.parseConfig(original);
    if (!parsed.ok) throw new Error(`${parsed.problem} Spotify Curator will not change a file it cannot read safely.`);

    const servers = asRecord(parsed.value.mcp);
    const conflicts = findConflicts(servers, entryName);
    const policy = options.conflictPolicy ?? EClientConflictPolicy.Abort;
    if (conflicts.length > 0 && policy === EClientConflictPolicy.Abort) {
      throw new Error(`OpenCode already has another Spotify server configured (${conflicts.join(', ')}). Choose to switch it off, or remove it yourself, then try again.`);
    }

    const desired: IMcpEntry = { type: 'local', command: [options.executablePath, 'mcp'], enabled: true };
    let text = original;
    const edit = (jsonPath: Array<string | number>, value: unknown): void => {
      text = applyEdits(text, modify(text, jsonPath, value, { formattingOptions: FORMAT }));
    };
    const current = servers[entryName] as IMcpEntry | undefined;
    const needsEntry = !current || !sameCommand(toStrings(current.command), toStrings(desired.command)) || current.type !== 'local' || current.enabled === false;
    if (needsEntry) edit(['mcp', entryName], { ...stripManaged(current), ...desired });
    const toDisable = policy === EClientConflictPolicy.Disable ? conflicts.filter((name) => (servers[name] as IMcpEntry).enabled !== false) : [];
    for (const name of toDisable) edit(['mcp', name, 'enabled'], false);

    if (text === original && present) {
      this.lastConfigPath = path;
      return { changed: false, configPath: path, backupPath: null, disabledConflicts: [] };
    }

    const backupPath = present ? await this.backup(path) : null;
    try {
      await this.writeFile(path, text);
      this.validateWritten(await readFile(path, 'utf8'), parsed.value, entryName, desired, toDisable);
    } catch (error) {
      await this.rollback(path, backupPath, present);
      throw new Error(`OpenCode's settings could not be updated safely, so your original settings were restored. (${(error as Error).message})`);
    }
    this.lastConfigPath = path;
    return { changed: true, configPath: path, backupPath, disabledConflicts: toDisable };
  }

  public async verify(): Promise<IVerificationResult> {
    const config = await this.inspect();
    const checks: IVerificationResult['checks'] = [];
    checks.push({ name: 'OpenCode settings are readable', ok: config.valid, detail: config.valid ? 'OK' : config.problems.join(' ') });
    checks.push({ name: 'Spotify Curator is registered in OpenCode', ok: config.registered && config.upToDate, detail: config.registered ? (config.upToDate ? 'OK' : config.problems.join(' ')) : 'Not registered yet.' });
    if (!config.command || !config.registered) return { ok: false, toolCount: null, checks };
    try {
      const result = await this.handshake(config.command);
      checks.push({ name: 'Spotify Curator starts and lists its tools', ok: result.toolNames.length > 0, detail: `${result.toolNames.length} tools` });
      return { ok: checks.every((c) => c.ok), toolCount: result.toolNames.length, checks };
    } catch (error) {
      checks.push({ name: 'Spotify Curator starts and lists its tools', ok: false, detail: `It did not start: ${(error as Error).message.split('\n')[0]}` });
      return { ok: false, toolCount: null, checks };
    }
  }

  public async uninstall(): Promise<void> {
    const { path, exists: present } = await this.resolveConfigPath();
    if (!present) return;
    const original = await readFile(path, 'utf8');
    const parsed = this.parseConfig(original);
    if (!parsed.ok) throw new Error(`${parsed.problem} Spotify Curator will not change a file it cannot read safely.`);
    if (!asRecord(parsed.value.mcp)[this.entryName]) return;
    const text = applyEdits(original, modify(original, ['mcp', this.entryName], undefined, { formattingOptions: FORMAT }));
    const backupPath = await this.backup(path);
    try {
      await this.writeFile(path, text);
      if (!this.parseConfig(await readFile(path, 'utf8')).ok) throw new Error('result was not valid');
    } catch (error) {
      await this.rollback(path, backupPath, true);
      throw new Error(`OpenCode's settings could not be updated safely, so your original settings were restored. (${(error as Error).message})`);
    }
  }

  // ---- helpers ---------------------------------------------------------

  private parseConfig(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; problem: string } {
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0 || value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, problem: 'OpenCode\'s settings file is not valid JSON/JSONC.' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  }

  /** Re-reads the written file: still valid, unrelated settings unchanged, our entry exactly as intended. */
  private validateWritten(text: string, before: Record<string, unknown>, entryName: string, desired: IMcpEntry, disabled: string[]): void {
    const parsed = this.parseConfig(text);
    if (!parsed.ok) throw new Error('the result was not valid JSON');
    const after = parsed.value;
    const afterServers = asRecord(after.mcp);
    const entry = afterServers[entryName] as IMcpEntry | undefined;
    if (!entry || entry.type !== 'local' || !sameCommand(toStrings(entry.command), toStrings(desired.command)) || entry.enabled !== true) {
      throw new Error('the new entry was not written correctly');
    }
    const expected = structuredClone(before);
    const expectedServers = asRecord(expected.mcp);
    for (const name of disabled) (expectedServers[name] as IMcpEntry).enabled = false;
    expectedServers[entryName] = entry;
    expected.mcp = expectedServers;
    if (JSON.stringify(sortDeep(after)) !== JSON.stringify(sortDeep(expected))) {
      throw new Error('unrelated settings would have changed');
    }
  }

  private async backup(path: string): Promise<string> {
    await mkdir(this.deps.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(this.deps.backupDir, `opencode-${stamp}-${path.endsWith('.jsonc') ? 'jsonc' : 'json'}.bak`);
    await copyFile(path, target);
    const old = (await readdir(this.deps.backupDir)).filter((f) => f.startsWith('opencode-')).sort();
    for (const file of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) await rm(join(this.deps.backupDir, file), { force: true });
    return target;
  }

  private async rollback(path: string, backupPath: string | null, existed: boolean): Promise<void> {
    if (backupPath) await copyFile(backupPath, path);
    else if (!existed) await rm(path, { force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sameCommand(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

/** Keep user additions (e.g. timeout) on our entry when updating it. */
function stripManaged(entry: IMcpEntry | undefined): IMcpEntry {
  if (!entry) return {};
  const { type: _type, command: _command, enabled: _enabled, ...rest } = entry;
  return rest;
}

/** Other entries that look like a Spotify MCP server (by name or by what they run). */
function findConflicts(servers: Record<string, unknown>, ownName: string): string[] {
  return Object.entries(servers)
    .filter(([name, value]) => {
      if (name === ownName) return false;
      const command = toStrings((value as IMcpEntry | undefined)?.command).join(' ').toLowerCase();
      return /spotify/i.test(name) || command.includes('spotify-custom-mcp') || command.includes('spotify-curator');
    })
    .map(([name]) => name);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortDeep(v)]));
  }
  return value;
}
