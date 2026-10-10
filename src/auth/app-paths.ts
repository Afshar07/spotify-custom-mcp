import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-user data directory. Deterministic; never derived from the working directory. */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPOTIFY_CURATOR_DATA_DIR) return env.SPOTIFY_CURATOR_DATA_DIR;
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'SpotifyCurator');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'spotify-curator');
}

export const SETTINGS_FILE = 'settings.json';
export const CREDENTIALS_FILE = 'credentials.bin';
export const LOG_FILE = 'spotify-curator.log';
