import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '../../src/history/store.js';
import { createMcpServer } from '../../src/mcp-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeSpotify, makeClient, McpTestSession, pagedRoute, playlistFixture, startSession, trackFixture } from '../helpers/fake-spotify.js';

let session: McpTestSession | undefined;
afterEach(async () => { await session?.close(); session = undefined; });
describe('plugin features through MCP', () => {
  it('returns a pending creative cover by default, supports opt-out, and keeps previews read-only', async () => {
    const fake = new FakeSpotify().on('GET', '/me', { id: 'me-user' }).on('GET', '/me/playlists', pagedRoute([]))
      .on('POST', '/me/playlists', playlistFixture('newp', 'Rain'));
    session = await startSession(fake);
    const preview = await session.call('create_playlist', { name: 'Rain', dryRun: true });
    expect(preview.json.cover).toBeUndefined();
    expect(fake.mutations).toHaveLength(0);
    const created = await session.call('create_playlist', { name: 'Rain' });
    expect(created.json.cover.status).toBe('pending');
    expect(created.json.cover.prompt).toContain('Rain');
    expect(created.json.cover.prompt).toContain("Never include the user's name");
    const noCover = await session.call('create_playlist', { name: 'Rain', coverArt: false });
    expect(noCover.json.cover).toBeUndefined();
  });
  it('passes cover opt-out through generate_playlist too', async () => {
    const fake = new FakeSpotify().on('GET', '/me', { id: 'me-user' }).on('GET', '/me/playlists', pagedRoute([]))
      .on('GET', '/tracks/t1', trackFixture('t1', 'Song')).on('POST', '/me/playlists', playlistFixture('newp', 'Rain'))
      .on('POST', '/playlists/newp/items', { snapshot_id: 's1' });
    session = await startSession(fake);
    for (const coverArt of [false, true]) {
      const result = await session.call('generate_playlist', { name: 'Rain', candidateTrackUris: ['spotify:track:t1'], targetTrackCount: 1, dryRun: false, coverArt });
      expect(result.isError).toBe(false);
      expect(result.json.creation.cover?.status).toBe(coverArt ? 'pending' : undefined);
    }
  });
  it('validates cover dry runs and rejects uploads to someone else\'s playlist', async () => {
    const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyuiiivdPmj//Z';
    const fake = new FakeSpotify().on('GET', '/me', { id: 'me-user' })
      .on('GET', '/playlists/own', playlistFixture('own', 'Mine'))
      .on('GET', '/playlists/other', playlistFixture('other', 'Other', 'another-user'));
    session = await startSession(fake);
    expect((await session.call('set_playlist_cover', { playlistId: 'own', jpegBase64 })).json.status).toBe('validated');
    expect((await session.call('set_playlist_cover', { playlistId: 'other', jpegBase64, dryRun: false })).isError).toBe(true);
    expect(fake.mutations).toHaveLength(0);
  });
  it('reads imported history through tools without sending history to Spotify', async () => {
    const root = await mkdtemp(join(tmpdir(), 'curator-history-mcp-'));
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'Streaming_History_Audio_1.json'), JSON.stringify([{ ts: '2026-01-01T00:00:00Z', ms_played: 123000,
      master_metadata_track_name: 'Rain', master_metadata_album_artist_name: 'Artist', spotify_track_uri: 'spotify:track:t1' }]));
    const history = new HistoryStore(join(root, 'data')); await history.importFolder(source);
    const fake = new FakeSpotify();
    const server = createMcpServer(makeClient(fake), { history });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    session = new McpTestSession(client, server);
    expect((await session.call('get_history_status')).json.eventCount).toBe(1);
    expect((await session.call('get_listening_profile')).json.tracks[0].listenedMs).toBe(123000);
    const checked = await session.call('check_tracks_in_history', { tracks: [{ name: 'Rain', artists: ['Artist'] }] });
    expect(checked.json.tracks[0].recordedStarts).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });
});
