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

export interface IAppContextOptions {
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
  public readonly handshake: (command: string[]) => Promise<IMcpHandshakeResult>;
  private readonly store: ICredentialStore;

  public constructor(private readonly options: IAppContextOptions = {}) {
    this.env = options.env ?? process.env;
    this.dataDir = getDataDir(this.env);
    this.executablePath = options.executablePath ?? this.env.SPOTIFY_CURATOR_EXE ?? process.execPath;
    this.handshake = options.handshake ?? ((command) => performMcpHandshake(command));
    this.chatGpt = new ChatGptDesktopAdapter({
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

  public settings(): Promise<IAppSettings | null> {
    return loadSettings(this.dataDir);
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
