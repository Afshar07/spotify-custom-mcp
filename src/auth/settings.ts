import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IAppSettings } from '../models/auth.js';
import { DEFAULT_REDIRECT_PORT, isPlausibleClientId } from './spotify-auth-service.js';
import { SETTINGS_FILE } from './app-paths.js';

/** Writes via a temp file so a crash never leaves a half-written file. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

export async function loadSettings(dataDir: string): Promise<IAppSettings | null> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, SETTINGS_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IAppSettings>;
    if (typeof parsed.clientId !== 'string' || !isPlausibleClientId(parsed.clientId)) return null;
    const port = Number(parsed.redirectPort);
    return {
      clientId: parsed.clientId.trim(),
      redirectPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_REDIRECT_PORT,
    };
  } catch {
    return null;
  }
}

export async function saveSettings(dataDir: string, settings: IAppSettings): Promise<void> {
  await writeFileAtomic(join(dataDir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
}
