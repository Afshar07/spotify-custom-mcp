import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../../src/history/store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'curator-history-'));
  const source = join(root, 'export');
  await mkdir(source);
  return { root, source, store: new HistoryStore(join(root, 'data')) };
}
function event(ts = '2026-09-12T12:00:00Z', overrides = {}) {
  return { ts, ms_played: 180000, master_metadata_track_name: 'The Fall', master_metadata_album_artist_name: 'Imagine Dragons', spotify_track_uri: 'spotify:track:abc123', skipped: false, ip_addr: 'private-address', ...overrides };
}
describe('optional local history', () => {
  it('works without an import', async () => {
    const { store } = await fixture();
    expect((await store.status()).connected).toBe(false);
    expect((await store.profile({})).connected).toBe(false);
  });
  it('deduplicates exact events, preserves repeat plays and excludes private export fields', async () => {
    const { source, root, store } = await fixture();
    await writeFile(join(source, 'Streaming_History_Audio_1.json'), JSON.stringify([event(), event(), event('2026-09-13T12:00:00Z')]));
    const status = await store.importFolder(source);
    expect(status.eventCount).toBe(2);
    expect(status.duplicateCount).toBe(1);
    expect(status.cutoff).toBe('2026-09-13T12:00:00.000Z');
    expect(await readFile(join(root, 'data', 'history', 'index.json'), 'utf8')).not.toContain('private-address');
    const profile = await store.profile({});
    expect(profile.tracks?.[0].listenedMs).toBe(360000);
    const checked = await store.checkTracks([{ uri: 'spotify:track:other', name: 'The Fall - Remastered 2025', artists: ['Imagine Dragons'] }]);
    expect(checked.tracks?.[0].recordedStarts).toBe(2);
    await store.clear();
    expect((await store.status()).connected).toBe(false);
  });
  it('keeps the prior index after a malformed import and never reports empty files as connected', async () => {
    const { source, store } = await fixture();
    const file = join(source, 'Streaming_History_Audio_1.json');
    await writeFile(file, JSON.stringify([event()]));
    await store.importFolder(source);
    await writeFile(file, '{broken');
    await expect(store.importFolder(source)).rejects.toThrow(/valid JSON/);
    expect((await store.status()).eventCount).toBe(1);
    await writeFile(file, '[]');
    await expect(store.importFolder(source)).rejects.toThrow(/music events/);
    expect((await store.status()).eventCount).toBe(1);
  });
  it('filters by date and artist and counts zero-duration encounters separately from sustained plays', async () => {
    const { source, store } = await fixture();
    await writeFile(join(source, 'Streaming_History_Audio_1.json'), JSON.stringify([event(), event('2026-08-01T00:00:00Z', { ms_played: 0, skipped: true })]));
    await store.importFolder(source);
    expect((await store.profile({ since: '2026-09-01', artist: 'imagine dragons' })).tracks?.[0].recordedStarts).toBe(1);
    expect((await store.profile({})).tracks?.[0].sustainedPlays).toBe(1);
  });
});
