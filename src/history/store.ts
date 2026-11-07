import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { writeFileAtomic } from '../auth/settings.js';

interface IHistoryEvent {
  ts: string;
  ms: number;
  uri: string | null;
  name: string;
  artist: string;
  skipped: boolean | null;
}
export interface IHistoryStatus {
  connected: boolean;
  eventCount: number;
  cutoff?: string;
  firstEvent?: string;
  importedAt?: string;
  sourceFolder?: string;
  duplicateCount?: number;
  ignoredCount?: number;
}
interface IHistoryIndex {
  version: 1;
  status: IHistoryStatus;
  events: IHistoryEvent[];
}
export interface IHistoryQuery {
  artist?: string;
  since?: string;
  until?: string;
  limit?: number;
}
export interface IHistoryTrack {
  uri?: string;
  name: string;
  artists: string[];
}
interface ITrackStats extends IHistoryTrack {
  recordedStarts: number;
  sustainedPlays: number;
  listenedMs: number;
  skippedStarts: number;
  lastPlayed: string;
}

/** Edition labels are not evidence that a song is unfamiliar. Keep live/acoustic variants distinct. */
export function normalizeHistoryName(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/\s*[-(\[]\s*(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|(?:deluxe|anniversary)(?:\s+edition)?)[^\])]*[\])]?(?=$)/gi, '')
    .replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}
function artistKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function musicEvent(value: unknown): IHistoryEvent | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.master_metadata_track_name !== 'string' || typeof row.master_metadata_album_artist_name !== 'string'
    || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts))
    || typeof row.ms_played !== 'number' || !Number.isFinite(row.ms_played) || row.ms_played < 0) return null;
  return {
    ts: new Date(row.ts).toISOString(), ms: row.ms_played,
    name: row.master_metadata_track_name, artist: row.master_metadata_album_artist_name,
    uri: typeof row.spotify_track_uri === 'string' && /^spotify:track:[a-zA-Z0-9]+$/.test(row.spotify_track_uri) ? row.spotify_track_uri : null,
    skipped: typeof row.skipped === 'boolean' ? row.skipped : null,
  };
}

/** Optional, per-user music history. No network calls; raw export fields are never retained. */
export class HistoryStore {
  private readonly path: string;
  private changing = false;
  public constructor(dataDir: string) { this.path = join(dataDir, 'history', 'index.json'); }

  private async load(): Promise<IHistoryIndex | null> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Local history could not be read.'); }
    try {
      const index = JSON.parse(raw) as IHistoryIndex;
      if (index.version !== 1 || !Array.isArray(index.events) || !index.status?.connected) throw new Error();
      return index;
    } catch { throw new Error('The local history index is invalid. Import your export again.'); }
  }
  public async status(): Promise<IHistoryStatus> {
    return (await this.load())?.status ?? { connected: false, eventCount: 0 };
  }
  public async importFolder(folder: string): Promise<IHistoryStatus> {
    if (this.changing) throw new Error('A history update is already running.');
    if (!isAbsolute(folder)) throw new Error('Choose an absolute path to your extracted history folder.');
    this.changing = true;
    try {
      const sourceFolder = await realpath(folder);
      const files = (await readdir(sourceFolder, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^(?:Streaming_History_Audio.*|endsong(?:_\d+)?)\.json$/i.test(entry.name))
        .map((entry) => entry.name).sort();
      if (!files.length || files.length > 200) throw new Error('Choose a folder with 1–200 extracted Spotify Extended Streaming History audio JSON files.');
      const events: IHistoryEvent[] = [];
      const seen = new Set<string>();
      let duplicateCount = 0, ignoredCount = 0, totalBytes = 0;
      for (const name of files) {
        const file = join(sourceFolder, name);
        const size = (await stat(file)).size;
        totalBytes += size;
        if (size > 100 * 1024 * 1024 || totalBytes > 1024 * 1024 * 1024) throw new Error('History export exceeds the import size limit (100 MB per file, 1 GB total).');
        let rows: unknown;
        try { rows = JSON.parse(await readFile(file, 'utf8')); }
        catch { throw new Error('A history file is not valid JSON. The previous import was kept.'); }
        if (!Array.isArray(rows)) throw new Error('Each history JSON file must contain an array of events.');
        for (const row of rows) {
          const event = musicEvent(row);
          if (!event) { ignoredCount++; continue; }
          const key = createHash('sha256').update(JSON.stringify(event)).digest('hex');
          if (seen.has(key)) { duplicateCount++; continue; }
          seen.add(key); events.push(event);
          if (events.length > 2_000_000) throw new Error('History import exceeds two million music events.');
        }
      }
      if (!events.length) throw new Error('No valid music events were found. The previous import was kept.');
      events.sort((a, b) => a.ts.localeCompare(b.ts));
      const status: IHistoryStatus = { connected: true, eventCount: events.length, firstEvent: events[0].ts,
        cutoff: events[events.length - 1].ts, importedAt: new Date().toISOString(), sourceFolder, duplicateCount, ignoredCount };
      const index: IHistoryIndex = { version: 1, status, events };
      await writeFileAtomic(this.path, JSON.stringify(index));
      return status;
    } finally { this.changing = false; }
  }
  public async refresh(): Promise<IHistoryStatus> {
    const status = await this.status();
    if (!status.sourceFolder) throw new Error('Choose a history folder before refreshing.');
    return this.importFolder(status.sourceFolder);
  }
  public async clear(): Promise<void> {
    if (this.changing) throw new Error('A history update is already running.');
    await rm(this.path, { force: true });
  }
  public async profile(query: IHistoryQuery): Promise<IHistoryStatus & { tracks?: ITrackStats[] }> {
    const index = await this.load();
    if (!index) return { connected: false, eventCount: 0 };
    const groups = new Map<string, ITrackStats>();
    const since = query.since ? Date.parse(query.since) : -Infinity;
    const until = query.until ? Date.parse(query.until) : Infinity;
    if (Number.isNaN(since) || Number.isNaN(until) || since > until) throw new Error('Provide a valid date range.');
    for (const event of index.events) {
      if ((query.artist && artistKey(event.artist) !== artistKey(query.artist)) || Date.parse(event.ts) < since || Date.parse(event.ts) > until) continue;
      const key = JSON.stringify([normalizeHistoryName(event.name), artistKey(event.artist)]);
      const group = groups.get(key) ?? { name: event.name, artists: [event.artist], ...(event.uri ? { uri: event.uri } : {}),
        recordedStarts: 0, sustainedPlays: 0, listenedMs: 0, skippedStarts: 0, lastPlayed: event.ts };
      group.recordedStarts++; group.sustainedPlays += Number(event.ms >= 30_000); group.listenedMs += event.ms;
      group.skippedStarts += Number(event.skipped === true); group.lastPlayed = event.ts;
      groups.set(key, group);
    }
    return { ...index.status, tracks: [...groups.values()].sort((a, b) => b.listenedMs - a.listenedMs).slice(0, Math.min(100, Math.max(1, query.limit ?? 30))) };
  }
  public async checkTracks(tracks: IHistoryTrack[]): Promise<IHistoryStatus & { tracks?: Array<IHistoryTrack & { recordedStarts: number; listenedMs: number }> }> {
    const index = await this.load();
    if (!index) return { connected: false, eventCount: 0 };
    const byUri = new Map<string, number[]>(), bySong = new Map<string, number[]>();
    const checked = tracks.map((track, i) => {
      if (track.uri) byUri.set(track.uri, [...byUri.get(track.uri) ?? [], i]);
      for (const artist of track.artists) {
        const key = JSON.stringify([normalizeHistoryName(track.name), artistKey(artist)]);
        bySong.set(key, [...bySong.get(key) ?? [], i]);
      }
      return { ...track, recordedStarts: 0, listenedMs: 0 };
    });
    for (const event of index.events) {
      const key = JSON.stringify([normalizeHistoryName(event.name), artistKey(event.artist)]);
      const matches = new Set([...(event.uri ? byUri.get(event.uri) ?? [] : []), ...bySong.get(key) ?? []]);
      for (const i of matches) { checked[i].recordedStarts++; checked[i].listenedMs += event.ms; }
    }
    return { ...index.status, tracks: checked };
  }
}
