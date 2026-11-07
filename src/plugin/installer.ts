import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { parse, patch } from '@decimalturn/toml-patch';
import { writeFileAtomic } from '../auth/settings.js';
import { performMcpHandshake } from '../clients/mcp-handshake.js';
import type { IMcpHandshakeResult, IVerificationResult } from '../models/client-adapter.js';
import { WindowsDpapiProtector } from '../auth/credential-store.js';
import type { ISecretProtector } from '../models/auth.js';

const NAME = 'spotify-curator';
const REQUIRED_TOOLS = ['generate_playlist', 'set_playlist_cover', 'get_history_status'];
const RESOURCE_FILES = ['plugin.json', '.codex-plugin/plugin.json',
  ...['music-curation', 'playlist-management', 'podcast-discovery', 'setup'].map((name) => `skills/${name}/SKILL.md`)];
interface IFileChange { path: string; before: string | null; after: string; }
interface IMigrationRecord { files: IFileChange[]; pluginPath: string; }
export interface IPluginInstallerOptions {
  protector?: ISecretProtector;
  home?: string;
  env?: NodeJS.ProcessEnv;
  dataDir: string;
  executablePath: string;
  sourceDir?: string;
  handshake?: (command: string[], options?: { env?: Record<string, string> }) => Promise<IMcpHandshakeResult>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Plugin settings could not be read. Check file permissions.'); }
}
function parseToml(raw: string): Record<string, unknown> {
  try { return record(parse(raw)); }
  catch { throw new Error('Desktop settings are not valid TOML. No connection was changed.'); }
}
function parseMarketplace(raw: string | null): Record<string, unknown> {
  try {
    const value = raw === null ? { name: 'spotify-curator-local', interface: { displayName: 'Local plugins' }, plugins: [] } : JSON.parse(raw);
    if (!value || typeof value.name !== 'string' || !value.name || !Array.isArray(value.plugins)) throw new Error();
    return value;
  } catch { throw new Error('Your local plugin marketplace is invalid. No connection was changed.'); }
}

/** Reads private legacy configuration at runtime. Secret values never enter plugin metadata. */
async function protectedEnvironment(path: string, protector: ISecretProtector): Promise<Record<string, string>> {
  const blob = await optionalFile(path);
  if (blob === null) return {};
  try {
    const value = JSON.parse(await protector.unprotect(blob));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) throw new Error();
    return value;
  } catch { throw new Error('The migrated environment could not be unlocked. Your original Spotify configuration was kept.'); }
}
export async function legacyMcpEnvironment(configPath: string, entryName: string, base: NodeJS.ProcessEnv, protector: ISecretProtector = new WindowsDpapiProtector()): Promise<NodeJS.ProcessEnv> {
  const raw = await optionalFile(configPath);
  if (raw === null) return { ...base };
  const entry = record(record(parseToml(raw).mcp_servers)[entryName]);
  const env = { ...base };
  if (base.SPOTIFY_CURATOR_LEGACY_ENV_FILE) {
    const saved = await protectedEnvironment(base.SPOTIFY_CURATOR_LEGACY_ENV_FILE, protector);
    for (const [key, value] of Object.entries(saved)) if (env[key] === undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(record(entry.env))) if (typeof value === 'string') env[key] = value;
  if (Array.isArray(entry.env_vars)) for (const key of entry.env_vars) {
    if (typeof key === 'string' && !env[key]) throw new Error('A legacy Spotify environment variable is unavailable. Keep the original connection enabled and repair it in Setup.');
  }
  if (typeof entry.cwd === 'string') {
    const { parse: parseDotenv } = await import('dotenv');
    const dotenv = await optionalFile(join(entry.cwd, '.env'));
    if (dotenv !== null) for (const [key, value] of Object.entries(parseDotenv(dotenv))) if (key.startsWith('SPOTIFY_') && env[key] === undefined) env[key] = value;
  }
  return env;
}

/** Local, restart-based migration. A persistent journal supports rollback and crash recovery. */
export class PluginInstaller {
  private readonly home: string;
  private readonly configPath: string;
  private readonly marketplacePath: string;
  private readonly journalPath: string;
  public constructor(private readonly options: IPluginInstallerOptions) {
    this.home = options.home ?? homedir();
    this.configPath = join(options.env?.CODEX_HOME || join(this.home, '.codex'), 'config.toml');
    this.marketplacePath = join(this.home, '.agents', 'plugins', 'marketplace.json');
    this.journalPath = join(options.dataDir, 'plugin-migration.json');
  }
  public async status(): Promise<{ installed: boolean; enabled: boolean }> {
    const market = parseMarketplace(await optionalFile(this.marketplacePath));
    const document = parseToml(await optionalFile(this.configPath) ?? '');
    const installed = (market.plugins as unknown[]).some((value) => record(value).name === NAME);
    const enabled = record(record(document.plugins)[`${NAME}@${market.name}`]).enabled === true;
    return { installed, enabled };
  }
  public async verify(): Promise<IVerificationResult> {
    try {
      if (!(await this.status()).enabled) throw new Error('Plugin is not enabled.');
      const market = parseMarketplace(await optionalFile(this.marketplacePath));
      const entry = (market.plugins as unknown[]).find((value) => record(value).name === NAME);
      const source = record(record(entry).source);
      if (source.source !== 'local' || !String(source.path).startsWith('./.codex/plugins/spotify-curator-local/')) throw new Error('Plugin source does not match this installation.');
      const root = join(this.home, String(source.path));
      const raw = await optionalFile(join(root, 'mcp.json'));
      const server = record(record(JSON.parse(raw ?? '{}').mcpServers)[NAME]);
      if (server.command !== basename(this.options.executablePath) || JSON.stringify(server.args) !== '["plugin-mcp"]') throw new Error('Plugin launch settings need repair.');
      const env = record(server.env);
      if (Object.values(env).some((value) => typeof value !== 'string')) throw new Error('Plugin environment is invalid.');
      if (typeof env.PATH !== 'string' || env.PATH.split(delimiter)[0] !== dirname(this.options.executablePath)) throw new Error('Plugin executable search path needs repair.');
      const result = await (this.options.handshake ?? performMcpHandshake)([server.command as string, 'plugin-mcp'], { env: env as Record<string, string> });
      if (result.serverName !== 'spotify-custom-mcp' || REQUIRED_TOOLS.some((name) => !result.toolNames.includes(name))) throw new Error('Plugin tools could not be verified.');
      return { ok: true, toolCount: result.toolNames.length, checks: [{ name: 'Spotify Curator plugin', ok: true, detail: `Plugin server starts with ${result.toolNames.length} tools. Restart your desktop app to load its skills; desktop loading is not checked here.` }] };
    } catch {
      return { ok: false, toolCount: null, checks: [{ name: 'Spotify Curator plugin', ok: false, detail: 'Plugin settings or server startup need attention. Choose Repair plugin in Spotify Curator Setup.' }] };
    }
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.options.dataDir, { recursive: true });
    const lockPath = join(this.options.dataDir, 'plugin-migration.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('The plugin migration lock could not be created.');
      const owner = await optionalFile(lockPath);
      const pid = Number(owner);
      let exited = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (failure) { exited = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (!exited || await optionalFile(lockPath) !== owner) throw new Error('A plugin migration is already running. Close the other Setup window before retrying.');
      await rm(lockPath);
      lock = await open(lockPath, 'wx', 0o600);
    }
    await lock.writeFile(String(process.pid));
    try { return await action(); }
    finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
  public async install(): Promise<{ pluginPath: string; toolCount: number; restartRequired: true }> {
    return this.locked(async () => {
      const beforeConfig = await optionalFile(this.configPath);
      const document = parseToml(beforeConfig ?? '');
      const servers = { ...record(document.mcp_servers) };
      const entries = Object.entries(servers).filter(([name, value]) => {
        const entry = record(value);
        return /^spotify[-_]curator$/i.test(name) && typeof entry.command === 'string';
      });
      if (entries.length > 1) throw new Error('Multiple legacy Spotify Curator entries were found. Choose one connection before upgrading.');
      const legacyName = entries[0]?.[0] ?? 'spotify-curator';
      const beforeMarket = await optionalFile(this.marketplacePath);
      const market = parseMarketplace(beforeMarket);
      const source = this.options.sourceDir ?? join(dirname(this.options.executablePath), 'plugin');
      const manifestText = await optionalFile(join(source, 'plugin.json'));
      if (!manifestText) throw new Error('Plugin resources are missing. Install the updated Spotify Curator package, then choose Upgrade to plugin.');
      const manifest = JSON.parse(manifestText) as { name: string; version: string };
      if (manifest.name !== NAME || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(manifest.version)) throw new Error('Plugin resources are invalid.');
      // Keep resources in a stable per-user path; the desktop copies them into its own plugin cache.
      const pluginPath = join(this.home, '.codex', 'plugins', 'spotify-curator-local', manifest.version);
      const oldManifest = await optionalFile(join(pluginPath, 'plugin.json'));
      if (oldManifest && JSON.parse(oldManifest).repository !== JSON.parse(manifestText).repository) throw new Error('Another plugin occupies the migration destination.');
      const privateEnvPath = join(this.options.dataDir, 'plugin-legacy-environment.bin');
      const protector = this.options.protector ?? new WindowsDpapiProtector();
      const legacyEntry = record(entries[0]?.[1]);
      const envNames = Array.isArray(legacyEntry.env_vars) ? legacyEntry.env_vars.filter((v): v is string => typeof v === 'string') : [];
      const archived = envNames.length ? await protectedEnvironment(privateEnvPath, protector) : {};
      const inherited: Record<string, string> = {};
      for (const key of envNames) {
        const value = (this.options.env ?? process.env)[key] ?? archived[key];
        if (value === undefined) throw new Error('A legacy environment setting is unavailable. Start Spotify Curator Setup from the same environment as your existing connection.');
        inherited[key] = value;
      }
      const inheritedPath = this.options.env?.PATH ?? this.options.env?.Path ?? process.env.PATH ?? process.env.Path;
      const env = { PATH: [dirname(this.options.executablePath), inheritedPath].filter(Boolean).join(delimiter),
        SPOTIFY_CURATOR_DATA_DIR: this.options.dataDir, SPOTIFY_CURATOR_LEGACY_CONFIG: this.configPath, SPOTIFY_CURATOR_LEGACY_ENTRY: legacyName,
        ...(envNames.length ? { SPOTIFY_CURATOR_LEGACY_ENV_FILE: privateEnvPath } : {}) };
      // Portable Agent Plugins reject absolute commands. Resolve the installed executable
      // through this process-specific PATH, without changing the user's system PATH.
      const command = [basename(this.options.executablePath), 'plugin-mcp'];
      const verification = await (this.options.handshake ?? performMcpHandshake)(command, { env: { ...inherited, ...env } });
      if (verification.serverName !== 'spotify-custom-mcp' || REQUIRED_TOOLS.some((tool) => !verification.toolNames.includes(tool))) throw new Error('The new Spotify Curator server could not verify its plugin tools. The old connection was kept.');
      const files: IFileChange[] = [];
      if (envNames.length) {
        const before = await optionalFile(privateEnvPath);
        const after = JSON.stringify(inherited) === JSON.stringify(archived) && before !== null ? before : await protector.protect(JSON.stringify(inherited));
        files.push({ path: privateEnvPath, before, after });
      }
      for (const name of RESOURCE_FILES) {
        const after = await optionalFile(join(source, name));
        if (after === null) throw new Error('A bundled plugin resource is missing. The old connection was kept.');
        const path = join(pluginPath, name);
        files.push({ path, before: await optionalFile(path), after });
      }
      const server = { type: 'stdio', command: command[0], args: command.slice(1), env };
      for (const name of ['mcp.json', '.mcp.json']) {
        const path = join(pluginPath, name);
        const after = JSON.stringify({ ...(name === 'mcp.json' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' } : {}), mcpServers: { [NAME]: server } }, null, 2) + '\n';
        files.push({ path, before: await optionalFile(path), after });
      }
      const plugins = [...market.plugins as unknown[]];
      const existing = plugins.findIndex((value) => record(value).name === NAME);
      if (existing >= 0) {
        const originalSource = record(record(plugins[existing]).source);
        if (originalSource.source !== 'local' || !String(originalSource.path).startsWith('./.codex/plugins/spotify-curator-local/')) throw new Error('Spotify Curator is already registered from another source. No connection was changed.');
      }
      const path = './' + relative(this.home, pluginPath).split(sep).join('/');
      const entry = { name: NAME, source: { source: 'local', path }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' };
      if (existing >= 0) plugins[existing] = entry; else plugins.push(entry);
      files.push({ path: this.marketplacePath, before: beforeMarket, after: JSON.stringify({ ...market, plugins }, null, 2) + '\n' });
      for (const [name, value] of entries) servers[name] = { ...record(value), enabled: false };
      const pluginKey = `${NAME}@${market.name}`;
      const pluginSettings = { ...record(document.plugins) };
      const previous = record(pluginSettings[pluginKey]);
      const legacy = record(entries[0]?.[1]);
      const policies: Record<string, unknown> = {};
      for (const key of ['enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec', 'tools']) if (legacy[key] !== undefined) policies[key] = legacy[key];
      pluginSettings[pluginKey] = { ...previous, enabled: true, mcp_servers: { ...record(previous.mcp_servers), [NAME]: { ...record(record(previous.mcp_servers)[NAME]), ...policies } } };
      const next = { ...document, ...(entries.length ? { mcp_servers: servers } : {}), plugins: pluginSettings };
      const afterConfig = patch(beforeConfig ?? '', next);
      parseToml(afterConfig);
      files.push({ path: this.configPath, before: beforeConfig, after: afterConfig });
      // Compare before writing anything, then journal the complete transaction before the first mutation.
      for (const file of files) if (await optionalFile(file.path) !== file.before) throw new Error('Settings changed during migration. Retry without closing your existing connection.');
      const previousJournal = await optionalFile(this.journalPath);
      if (files.every((file) => file.before === file.after)) return { pluginPath, toolCount: verification.toolNames.length, restartRequired: true };
      const migration: IMigrationRecord = { files, pluginPath };
      await writeFileAtomic(this.journalPath, JSON.stringify(migration));
      const written: IFileChange[] = [];
      try {
        for (const file of files) {
          if (await optionalFile(file.path) !== file.before) throw new Error('Settings changed during migration.');
          await writeFileAtomic(file.path, file.after); written.push(file);
        }
      } catch {
        for (const file of written.reverse()) if (await optionalFile(file.path) === file.after) await this.restore(file);
        if (previousJournal === null) await rm(this.journalPath, { force: true }); else await writeFileAtomic(this.journalPath, previousJournal);
        throw new Error('The plugin could not be installed. Existing settings were restored where unchanged.');
      }
      return { pluginPath, toolCount: verification.toolNames.length, restartRequired: true };
    });
  }
  private async restore(file: IFileChange): Promise<void> {
    if (file.before === null) await rm(file.path, { force: true });
    else await writeFileAtomic(file.path, file.before);
  }
  public async connectionEnvironment(): Promise<NodeJS.ProcessEnv> {
    const document = parseToml(await optionalFile(this.configPath) ?? '');
    const names = Object.keys(record(document.mcp_servers)).filter((name) => /^spotify[-_]curator$/i.test(name));
    return legacyMcpEnvironment(this.configPath, names[0] ?? NAME,
      { ...this.options.env, SPOTIFY_CURATOR_LEGACY_ENV_FILE: join(this.options.dataDir, 'plugin-legacy-environment.bin') }, this.options.protector);
  }
  public async uninstall(): Promise<void> {
    await this.locked(async () => {
      const rawMarket = await optionalFile(this.marketplacePath);
      if (rawMarket === null) return;
      const market = parseMarketplace(rawMarket);
      const plugins = (market.plugins as unknown[]).filter((value) => {
        const entry = record(value), source = record(entry.source);
        return !(entry.name === NAME && source.source === 'local' && String(source.path).startsWith('./.codex/plugins/spotify-curator-local/'));
      });
      if (plugins.length === (market.plugins as unknown[]).length) return;
      const rawConfig = await optionalFile(this.configPath);
      const document = parseToml(rawConfig ?? '');
      const settings = { ...record(document.plugins) };
      delete settings[`${NAME}@${market.name}`];
      const servers = { ...record(document.mcp_servers) };
      const journal = await optionalFile(this.journalPath);
      if (journal) {
        const migration = JSON.parse(journal) as IMigrationRecord;
        const savedConfig = migration.files.find((file) => file.path === this.configPath);
        const migratedServers = record(parseToml(savedConfig?.after ?? '').mcp_servers);
        for (const [name, value] of Object.entries(servers)) {
          if (/^spotify[-_]curator$/i.test(name) && record(value).enabled === false
            && JSON.stringify(value) === JSON.stringify(migratedServers[name])) delete servers[name];
        }
      }
      const nextMarket = JSON.stringify({ ...market, plugins }, null, 2) + '\n';
      const nextConfig = patch(rawConfig ?? '', { ...document, ...(document.mcp_servers ? { mcp_servers: servers } : {}), plugins: settings });
      if (await optionalFile(this.configPath) !== rawConfig || await optionalFile(this.marketplacePath) !== rawMarket) throw new Error('Settings changed during plugin cleanup.');
      await writeFileAtomic(this.marketplacePath, nextMarket);
      try { await writeFileAtomic(this.configPath, nextConfig); }
      catch (error) { if (await optionalFile(this.marketplacePath) === nextMarket) await writeFileAtomic(this.marketplacePath, rawMarket); throw error; }
      await rm(this.journalPath, { force: true });
    });
  }
  public async rollback(): Promise<void> {
    return this.locked(async () => {
      const raw = await optionalFile(this.journalPath);
      if (!raw) throw new Error('There is no plugin migration to undo.');
      const migration = JSON.parse(raw) as IMigrationRecord;
      for (const file of migration.files) {
        const current = await optionalFile(file.path);
        if (current !== file.after && current !== file.before) throw new Error('Settings changed after migration. Automatic rollback would overwrite newer edits.');
      }
      for (const file of [...migration.files].reverse()) if (await optionalFile(file.path) === file.after) await this.restore(file);
      await rm(this.journalPath, { force: true });
    });
  }
}
