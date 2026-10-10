import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, patch } from '@decimalturn/toml-patch';
import { writeFileAtomic } from '../auth/settings.js';
import {
  EClientConflictPolicy, EClientDetection, EClientSupport,
  type IClientConfiguration, type IClientDetectionResult, type IInstallOptions,
  type IInstallResult, type IMcpClientAdapter, type IVerificationResult,
} from '../models/client-adapter.js';
import { performMcpHandshake } from './mcp-handshake.js';

const ENTRY_NAME = 'spotify-curator';

export interface IChatGptAdapterDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  backupDir?: string;
  expectedCommand?: string[];
  writeFile?: typeof writeFileAtomic;
  handshake?: typeof performMcpHandshake;
}

/** Documented local desktop/Codex host config, not hosted ChatGPT plugin registration. */
export class ChatGptDesktopAdapter implements IMcpClientAdapter {
  public readonly id = 'chatgpt-desktop';
  public readonly name = 'ChatGPT Desktop';
  public readonly support = EClientSupport.Supported;
  private configPath: string;
  private readonly backupDir: string;
  private expectedCommand?: string[];

  public constructor(private readonly deps: IChatGptAdapterDeps = {}) {
    const env = deps.env ?? process.env;
    const home = deps.home ?? homedir();
    this.configPath = join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');
    this.backupDir = deps.backupDir ?? join(home, '.spotify-curator', 'backups');
    this.expectedCommand = deps.expectedCommand;
  }

  public async detect(): Promise<IClientDetectionResult> {
    return {
      installed: EClientDetection.Unknown, support: this.support, configPath: this.configPath,
      detail: 'Local desktop MCP setup is supported. Restart ChatGPT after setup; desktop installation and hosted Chat availability are not checked.',
    };
  }

  public async inspect(): Promise<IClientConfiguration> {
    const raw = await readOptional(this.configPath);
    const result: IClientConfiguration = {
      configPath: this.configPath, configExists: raw !== null, valid: true,
      registered: false, upToDate: false, command: null, conflicts: [], problems: [],
    };
    if (raw === null) return result;
    let document: Record<string, unknown>;
    try { document = parseConfig(raw); }
    catch { return { ...result, valid: false, problems: ['ChatGPT settings are not valid TOML. No changes were made.'] }; }
    const servers = record(document.mcp_servers);
    const entry = record(servers[ENTRY_NAME]);
    result.registered = Object.hasOwn(servers, ENTRY_NAME);
    if (typeof entry.command === 'string' && (entry.args === undefined || isStringArray(entry.args))) {
      result.command = [entry.command, ...(isStringArray(entry.args) ? entry.args : [])];
    }
    result.upToDate = result.registered && entry.enabled !== false && entry.url === undefined && !!result.command
      && (!this.expectedCommand || isDeepStrictEqual(result.command, this.expectedCommand));
    if (result.registered && !result.upToDate) result.problems.push('Spotify Curator is disabled or points to a different program. Run setup again to repair it.');
    result.conflicts = findConflicts(servers);
    return result;
  }

  public manualSteps(executablePath: string): string[] {
    return [
      'Open ChatGPT Desktop → Settings → MCP servers → Add server.',
      `Name: ${ENTRY_NAME}. Type: STDIO. Command: ${executablePath}. Arguments: mcp.`,
      'Save and restart ChatGPT. In a local chat, use /mcp to check connected servers, then ask to search Spotify.',
      'Connect Spotify in Spotify Curator Setup first. Hosted ChatGPT web connections use a separate plugin setup.',
    ];
  }

  public async install(options: IInstallOptions): Promise<IInstallResult> {
    const path = options.configPath ?? this.configPath;
    if (options.entryName && options.entryName !== ENTRY_NAME) throw new Error('The ChatGPT entry name must be spotify-curator.');
    const original = await readOptional(path);
    const before = parseConfig(original ?? '');
    const servers = record(before.mcp_servers);
    const conflicts = findConflicts(servers);
    if (conflicts.length && options.conflictPolicy !== EClientConflictPolicy.Disable) {
      throw new Error('ChatGPT already has another Spotify server configured. Choose to switch it off, then try again.');
    }
    const entry: Record<string, unknown> = { ...record(servers[ENTRY_NAME]), command: options.executablePath, args: ['mcp'], enabled: true };
    // Preserve tool policies/timeouts, but remove obsolete transport and credential overrides.
    for (const key of ['url', 'auth', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'http_headers_helper', 'oauth', 'env', 'env_vars', 'cwd', 'experimental_environment']) delete entry[key];
    const updatedServers: Record<string, unknown> = { ...servers, [ENTRY_NAME]: entry };
    const disabled = conflicts.filter((name) => record(servers[name]).enabled !== false);
    for (const name of disabled) updatedServers[name] = { ...record(servers[name]), enabled: false };
    const after = { ...before, mcp_servers: updatedServers };
    const text = patch(original ?? '', after);
    const changed = original === null || text !== original;
    const backupPath = changed ? await this.writeSafely(path, original, text, after) : null;
    this.configPath = path;
    this.expectedCommand = [options.executablePath, 'mcp'];
    return { changed, configPath: path, backupPath, disabledConflicts: disabled };
  }

  public async verify(): Promise<IVerificationResult> {
    const config = await this.inspect();
    const checks: IVerificationResult['checks'] = [
      { name: 'Desktop settings', ok: config.valid && config.registered && config.upToDate,
        detail: config.valid && config.registered && config.upToDate ? 'Registered in desktop MCP settings.' : config.problems.join(' ') || 'Spotify Curator is not set up in ChatGPT Desktop.' },
    ];
    if (!checks[0].ok || !config.command) return { ok: false, toolCount: null, checks };
    try {
      const result = await (this.deps.handshake ?? performMcpHandshake)(config.command);
      const ok = result.serverName === 'spotify-custom-mcp' && result.toolNames.length > 0;
      checks.push({ name: 'Server startup and tools', ok, detail: ok ? `${result.toolNames.length} tools available. Restart ChatGPT to load them; desktop invocation has not been tested by this check.` : 'The registered program did not identify itself as Spotify Curator with available tools.' });
      return { ok, toolCount: result.toolNames.length, checks };
    } catch {
      checks.push({ name: 'Server startup and tools', ok: false, detail: 'Spotify Curator could not start and list tools. Check the installed executable and run setup again.' });
      return { ok: false, toolCount: null, checks };
    }
  }

  public async uninstall(): Promise<void> {
    const original = await readOptional(this.configPath);
    if (original === null) return;
    const before = parseConfig(original);
    const servers = { ...record(before.mcp_servers) };
    if (!Object.hasOwn(servers, ENTRY_NAME)) return;
    const config = await this.inspect();
    if (this.expectedCommand && !isDeepStrictEqual(config.command, this.expectedCommand)) {
      throw new Error('The ChatGPT entry now points to a different program. Remove it manually in ChatGPT settings.');
    }
    delete servers[ENTRY_NAME];
    const after = { ...before, mcp_servers: servers };
    await this.writeSafely(this.configPath, original, patch(original, after), after);
  }

  private async writeSafely(path: string, original: string | null, text: string, expected: Record<string, unknown>): Promise<string | null> {
    if (!sameDocument(parseConfig(text), expected)) throw new Error('The TOML update would change unrelated settings. No changes were made.');
    let backupPath: string | null = null;
    if (original !== null) {
      await mkdir(this.backupDir, { recursive: true });
      backupPath = join(this.backupDir, `chatgpt-${Date.now()}-${randomUUID()}.toml.bak`);
      await writeFileAtomic(backupPath, original);
      const backups = (await readdir(this.backupDir)).filter((name) => name.startsWith('chatgpt-') && name.endsWith('.toml.bak')).sort();
      for (const name of backups.slice(0, Math.max(0, backups.length - 10))) await rm(join(this.backupDir, name));
    }
    if (await readOptional(path) !== original) throw new Error('ChatGPT settings changed during setup. Try again.');
    try {
      await (this.deps.writeFile ?? writeFileAtomic)(path, text);
      if (!sameDocument(parseConfig(await readFile(path, 'utf8')), expected)) throw new Error('verification failed');
    } catch {
      if (backupPath) await copyFile(backupPath, path);
      else await rm(path, { force: true });
      throw new Error('ChatGPT settings could not be updated safely. The original settings were restored.');
    }
    return backupPath;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('ChatGPT settings could not be read. Check file permissions.');
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseConfig(text: string): Record<string, unknown> {
  try {
    const value = parse(text) as Record<string, unknown>;
    if (value.mcp_servers !== undefined) {
      if (value.mcp_servers === null || typeof value.mcp_servers !== 'object' || Array.isArray(value.mcp_servers)) throw new Error();
      for (const entry of Object.values(value.mcp_servers)) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
      }
    }
    return value;
  } catch {
    // Parser errors can contain source lines with credentials; never expose them.
    throw new Error('ChatGPT settings are not valid TOML. No changes were made.');
  }
}

function findConflicts(servers: Record<string, unknown>): string[] {
  return Object.entries(servers).filter(([name, value]) => {
    if (name === ENTRY_NAME) return false;
    const entry = record(value);
    if (entry.enabled === false) return false;
    const command = [entry.command, ...(isStringArray(entry.args) ? entry.args : []), entry.url].join(' ');
    return /spotify/i.test(name) || /spotify-custom-mcp|spotify-curator/i.test(command);
  }).map(([name]) => name);
}

function sameDocument(a: unknown, b: unknown): boolean {
  // The TOML parser returns null-prototype tables; object spreads produce ordinary objects.
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
    }
    return value;
  }
  return isDeepStrictEqual(normalize(a), normalize(b));
}
