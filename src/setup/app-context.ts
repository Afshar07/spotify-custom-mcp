import { join } from 'node:path';
import { CREDENTIALS_FILE, getDataDir } from '../auth/app-paths.js';
import { createDefaultCredentialStore } from '../auth/credential-store.js';
import { openInDefaultBrowser } from '../auth/open-browser.js';
import { loadSettings } from '../auth/settings.js';
import { SpotifyAuthService } from '../auth/spotify-auth-service.js';
import { ChatGptDesktopAdapter } from '../clients/chatgpt-adapter.js';
import { performMcpHandshake } from '../clients/mcp-handshake.js';
import { OpenCodeAdapter } from '../clients/opencode-adapter.js';
import type { IAppSettings, ICredentialStore } from '../models/auth.js';
import type { IMcpHandshakeResult } from '../models/client-adapter.js';
import { APP_VERSION } from '../version.js';
import { HistoryStore } from '../history/store.js';
import { PluginInstaller } from '../plugin/installer.js';
import { resolve } from 'node:path';
import { pickHistoryFolder } from '../history/pick-folder.js';
import { isPlausibleClientId, DEFAULT_REDIRECT_PORT } from '../auth/spotify-auth-service.js';

export interface IAppContextOptions {
  pickHistoryFolder?: () => Promise<string | null>;
  pluginSourceDir?: string;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  home?: string;
  fetch?: typeof fetch;
  createStore?: (path: string) => ICredentialStore;
  openBrowser?: (url: string) => Promise<void>;
  handshake?: (command: string[]) => Promise<IMcpHandshakeResult>;
}

/** Wires the shared services once, so the CLI, the setup wizard and diagnostics agree. */
export class AppContext {
  public readonly env: NodeJS.ProcessEnv;
  public readonly dataDir: string;
  public readonly executablePath: string;
  public readonly version = APP_VERSION;
  public readonly openCode: OpenCodeAdapter;
  public readonly chatGpt: ChatGptDesktopAdapter;
  public readonly history: HistoryStore;
  public readonly plugin: PluginInstaller;
  public readonly handshake: (command: string[]) => Promise<IMcpHandshakeResult>;
  private readonly store: ICredentialStore;

  public constructor(private readonly options: IAppContextOptions = {}) {
    this.env = options.env ?? process.env;
    this.dataDir = getDataDir(this.env);
    this.executablePath = options.executablePath ?? this.env.SPOTIFY_CURATOR_EXE ?? process.execPath;
    this.handshake = options.handshake ?? ((command) => performMcpHandshake(command));
    this.history = new HistoryStore(this.dataDir);
    this.plugin = new PluginInstaller({ home: options.home, env: this.env, dataDir: this.dataDir,
      executablePath: this.executablePath,
      sourceDir: options.pluginSourceDir ?? (this.env.SPOTIFY_CURATOR_PACKAGED === '1' ? undefined : resolve('plugins/spotify-curator')),
      handshake: options.handshake,
    });
    this.chatGpt = new ChatGptDesktopAdapter({
      plugin: this.plugin,
      env: this.env, home: options.home, backupDir: join(this.dataDir, 'backups'),
      expectedCommand: [this.executablePath, 'mcp'], handshake: this.handshake,
    });
    const path = join(this.dataDir, CREDENTIALS_FILE);
    this.store = (options.createStore ?? createDefaultCredentialStore)(path);
    this.openCode = new OpenCodeAdapter({
      env: this.env,
      home: options.home,
      backupDir: join(this.dataDir, 'backups'),
      handshake: (command) => this.handshake(command) as ReturnType<typeof performMcpHandshake>,
    });
  }

  public async settings(): Promise<IAppSettings | null> {
    const saved = await loadSettings(this.dataDir);
    if (saved) return saved;
    // Reuse the legacy app's public Client ID for an optional cover-consent upgrade.
    const env = await this.plugin.connectionEnvironment();
    if (!env.SPOTIFY_CLIENT_ID || !isPlausibleClientId(env.SPOTIFY_CLIENT_ID)) return null;
    let redirectPort = DEFAULT_REDIRECT_PORT;
    if (env.SPOTIFY_REDIRECT_URI) {
      try {
        const uri = new URL(env.SPOTIFY_REDIRECT_URI);
        if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || uri.pathname !== '/callback') throw new Error();
        redirectPort = Number(uri.port) || 80;
      } catch { return null; }
    }
    return { clientId: env.SPOTIFY_CLIENT_ID, redirectPort };
  }

  public async hasLegacyConnection(): Promise<boolean> {
    const env = await this.plugin.connectionEnvironment();
    return Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET && env.SPOTIFY_REFRESH_TOKEN);
  }

  public chooseHistoryFolder(): Promise<string | null> {
    return (this.options.pickHistoryFolder ?? pickHistoryFolder)();
  }

  public authFor(settings: IAppSettings): SpotifyAuthService {
    return new SpotifyAuthService({
      clientId: settings.clientId,
      redirectPort: settings.redirectPort,
      store: this.store,
      fetch: this.options.fetch,
      openBrowser: this.options.openBrowser ?? openInDefaultBrowser,
      log: (message) => process.stderr.write(`${message}\n`),
    });
  }

  public async auth(): Promise<SpotifyAuthService | null> {
    const settings = await this.settings();
    return settings ? this.authFor(settings) : null;
  }

  public credentialStore(): ICredentialStore {
    return this.store;
  }
}
