import { AuthError, NOT_CONNECTED_MESSAGE } from './auth/auth-error.js';
import { getDataDir, CREDENTIALS_FILE } from './auth/app-paths.js';
import { createDefaultCredentialStore } from './auth/credential-store.js';
import { loadSettings } from './auth/settings.js';
import { SpotifyAuthService } from './auth/spotify-auth-service.js';
import { getSpotifyConfig } from './config.js';
import { EAuthErrorCode, type ICredentialStore, type ITokenProvider } from './models/auth.js';
import { SpotifyClient } from './spotify.js';
import { join } from 'node:path';

export interface IRuntimeDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the Windows credential store. */
  createStore?: (path: string) => ICredentialStore;
  fetch?: typeof fetch;
}

const NOT_SET_UP_MESSAGE =
  'Spotify Curator is not set up yet. Open Spotify Curator Setup, enter your Spotify Client ID, and connect Spotify.';

/** Stands in when nothing is configured, so the MCP still starts and explains what to do. */
class UnavailableTokenProvider implements ITokenProvider {
  public constructor(private readonly message: string) {}
  public async getAccessToken(): Promise<never> {
    throw new AuthError(EAuthErrorCode.NotConnected, this.message);
  }
}

/**
 * Chooses credentials for the MCP process, never touching stdout:
 * 1. Existing env-var installs (SPOTIFY_CLIENT_ID/SECRET/REFRESH_TOKEN) keep working unchanged.
 * 2. Otherwise PKCE credentials from settings.json + the per-user secure store.
 * 3. Otherwise the server starts and every Spotify call explains how to connect.
 */
export async function createRuntimeSpotifyClient(deps: IRuntimeDeps = {}): Promise<SpotifyClient> {
  const env = deps.env ?? process.env;
  const placeholder = { clientId: '', clientSecret: '', refreshToken: '', redirectUri: '' };

  if (env.SPOTIFY_CLIENT_ID && env.SPOTIFY_REFRESH_TOKEN && env.SPOTIFY_CLIENT_SECRET) {
    return new SpotifyClient(getSpotifyConfig(env), { fetch: deps.fetch });
  }

  const dataDir = getDataDir(env);
  const settings = await loadSettings(dataDir);
  if (!settings) {
    return new SpotifyClient(placeholder, { tokenProvider: new UnavailableTokenProvider(NOT_SET_UP_MESSAGE), fetch: deps.fetch });
  }

  let store: ICredentialStore;
  try {
    store = (deps.createStore ?? createDefaultCredentialStore)(join(dataDir, CREDENTIALS_FILE));
  } catch (error) {
    const message = error instanceof Error ? error.message : NOT_CONNECTED_MESSAGE;
    return new SpotifyClient(placeholder, { tokenProvider: new UnavailableTokenProvider(message), fetch: deps.fetch });
  }
  const auth = new SpotifyAuthService({
    clientId: settings.clientId,
    redirectPort: settings.redirectPort,
    store,
    fetch: deps.fetch,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  return new SpotifyClient({ ...placeholder, clientId: settings.clientId }, { tokenProvider: auth, fetch: deps.fetch });
}
