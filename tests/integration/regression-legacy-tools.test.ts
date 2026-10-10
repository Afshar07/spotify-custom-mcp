import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeSpotify,
  itemFixture,
  pagedRoute,
  startSession,
  trackFixture,
  type McpTestSession,
} from '../helpers/fake-spotify.js';

const LEGACY_TOOLS = [
  'search_tracks',
  'get_playlist_items',
  'get_playlist_summary',
  'add_playlist_items',
  'add_unique_playlist_items',
  'remove_playlist_items',
  'reorder_playlist_items',
  'replace_playlist_items',
  'add_liked_tracks',
];

const PLAYLIST = 'pl1';
let session: McpTestSession | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
});

function playlistFake(trackIds: string[] = ['e1', 'e2']) {
  const items = trackIds.map((id) => itemFixture(trackFixture(id)));
  return new FakeSpotify()
    .on('GET', `/playlists/${PLAYLIST}`, { snapshot_id: 'snap-1' })
    .on('GET', `/playlists/${PLAYLIST}/items`, pagedRoute(items))
    .on('POST', `/playlists/${PLAYLIST}/items`, { snapshot_id: 'snap-2' })
    .on('DELETE', `/playlists/${PLAYLIST}/items`, { snapshot_id: 'snap-3' })
    .on('PUT', `/playlists/${PLAYLIST}/items`, { snapshot_id: 'snap-4' });
}

describe('legacy tools: registration and contracts', () => {
  it('still registers all nine original tools under their original names', async () => {
    session = await startSession(new FakeSpotify());
    const names = await session.toolNames();
    for (const tool of LEGACY_TOOLS) {
      expect(names).toContain(tool);
    }
  });

  it('keeps the documented input schemas', async () => {
    session = await startSession(new FakeSpotify());
    const { tools } = await session.client.listTools();
    const schema = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema as {
      properties: Record<string, { maximum?: number; minimum?: number; maxItems?: number; minItems?: number; default?: unknown }>;
      required?: string[];
    };

    expect(schema('search_tracks').properties.limit).toMatchObject({ maximum: 10, minimum: 1, default: 5 });
    expect(schema('search_tracks').required).toEqual(['query']);
    expect(schema('get_playlist_items').properties.limit).toMatchObject({ maximum: 100, default: 100 });
    expect(schema('add_playlist_items').properties.uris).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(schema('add_unique_playlist_items').properties.uris).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(schema('remove_playlist_items').properties.uris).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(schema('replace_playlist_items').properties.uris).toMatchObject({ maxItems: 100 });
    expect(schema('add_liked_tracks').properties.uris).toMatchObject({ minItems: 1, maxItems: 40 });
    for (const tool of ['add_playlist_items', 'add_unique_playlist_items', 'remove_playlist_items', 'reorder_playlist_items', 'replace_playlist_items']) {
      expect(Object.keys(schema(tool).properties)).toContain('expectedSnapshotId');
      expect(schema(tool).properties.dryRun).toMatchObject({ default: false });
    }
    expect(Object.keys(schema('remove_playlist_items').properties)).toContain('snapshotId');
    expect(Object.keys(schema('reorder_playlist_items').properties)).toEqual(
      expect.arrayContaining(['rangeStart', 'insertBefore', 'rangeLength', 'snapshotId']),
    );
  });

  it('describes destructive tools as destructive', async () => {
    session = await startSession(new FakeSpotify());
    const { tools } = await session.client.listTools();
    expect(tools.find((tool) => tool.name === 'replace_playlist_items')?.description).toMatch(/Destructive/);
  });
});

describe('legacy tools: behavior', () => {
  it('search_tracks returns compact summaries and caps the Spotify limit at 10', async () => {
    const fake = new FakeSpotify().on('GET', '/search', { tracks: { items: [trackFixture('s1', 'Song', { artists: ['Band'], album: 'LP' })] } });
    session = await startSession(fake);

    const result = await session.call('search_tracks', { query: 'band song', limit: 10 });
    expect(result.json).toEqual([
      {
        id: 's1',
        uri: 'spotify:track:s1',
        name: 'Song',
        artists: ['Band'],
        album: 'LP',
        durationMs: 180000,
        explicit: false,
        url: 'https://open.spotify.com/track/s1',
      },
    ]);
    expect(fake.requests[0].query.get('limit')).toBe('10');

    expect((await session.call('search_tracks', { query: 'x', limit: 11 })).isError).toBe(true);
    expect((await session.call('search_tracks', { query: '' })).isError).toBe(true);
  });

  it('get_playlist_items reads the /items endpoint and keeps its output fields', async () => {
    const fake = playlistFake(['e1', 'e2', 'e3']);
    session = await startSession(fake);

    const page = await session.call('get_playlist_items', { playlistId: PLAYLIST, limit: 2 });
    expect(page.json).toMatchObject({ total: 3, offset: 0, limit: 2 });
    expect(page.json.next).toEqual(expect.any(String));
    expect(page.json.items.map((track: { uri: string }) => track.uri)).toEqual(['spotify:track:e1', 'spotify:track:e2']);
    expect(fake.requests[0].path).toBe(`/playlists/${PLAYLIST}/items`);

    const all = await session.call('get_playlist_items', { playlistId: PLAYLIST, limit: 2, all: true });
    expect(all.json.items).toHaveLength(3);
    expect(all.json.next).toBeNull();
  });

  it('get_playlist_summary returns the snapshot ID and compact tracks', async () => {
    session = await startSession(playlistFake(['e1']));
    const result = await session.call('get_playlist_summary', { playlistId: PLAYLIST });
    expect(result.json).toEqual({
      playlistId: PLAYLIST,
      totalItemCount: 1,
      snapshotId: 'snap-1',
      tracks: [{ uri: 'spotify:track:e1', name: 'Track e1', artists: ['Artist One'] }],
    });
  });

  it('add_unique_playlist_items skips duplicates in the playlist and in the request', async () => {
    const fake = playlistFake(['e1', 'e2']);
    session = await startSession(fake);

    const result = await session.call('add_unique_playlist_items', {
      playlistId: PLAYLIST,
      uris: ['spotify:track:e1', 'spotify:track:n1', 'spotify:track:n1', 'spotify:track:n2'],
    });
    expect(result.json).toEqual({
      requestedUris: ['spotify:track:e1', 'spotify:track:n1', 'spotify:track:n1', 'spotify:track:n2'],
      addedUris: ['spotify:track:n1', 'spotify:track:n2'],
      skippedDuplicateUris: ['spotify:track:e1', 'spotify:track:n1'],
      resultingSnapshotId: 'snap-2',
    });
    expect(fake.mutations).toHaveLength(1);
    expect(fake.mutations[0].body).toEqual({ uris: ['spotify:track:n1', 'spotify:track:n2'] });
  });

  it('add_unique_playlist_items sends nothing when everything is a duplicate', async () => {
    const fake = playlistFake(['e1']);
    session = await startSession(fake);
    const result = await session.call('add_unique_playlist_items', { playlistId: PLAYLIST, uris: ['spotify:track:e1'] });
    expect(result.json.addedUris).toEqual([]);
    expect(result.json.skippedDuplicateUris).toEqual(['spotify:track:e1']);
    expect(fake.mutations).toHaveLength(0);
  });

  it('add_unique_playlist_items passes the position through and honors dryRun', async () => {
    const fake = playlistFake(['e1']);
    session = await startSession(fake);

    await session.call('add_unique_playlist_items', { playlistId: PLAYLIST, uris: ['spotify:track:n1'], position: 0 });
    expect(fake.mutations[0].query.get('position')).toBe('0');

    const dry = await session.call('add_unique_playlist_items', { playlistId: PLAYLIST, uris: ['spotify:track:n2'], dryRun: true });
    expect(dry.json).toMatchObject({ dryRun: true, addedUris: ['spotify:track:n2'] });
    expect(fake.mutations).toHaveLength(1);
  });

  it('rejects a stale expectedSnapshotId before any mutation, on every mutation tool', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['add_playlist_items', { uris: ['spotify:track:n1'] }],
      ['add_unique_playlist_items', { uris: ['spotify:track:n1'] }],
      ['remove_playlist_items', { uris: ['spotify:track:e1'] }],
      ['reorder_playlist_items', { rangeStart: 1, insertBefore: 0 }],
      ['replace_playlist_items', { uris: ['spotify:track:n1'] }],
    ];
    for (const [tool, args] of calls) {
      const fake = playlistFake();
      session = await startSession(fake);
      const result = await session.call(tool, { playlistId: PLAYLIST, expectedSnapshotId: 'stale', ...args });
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toMatch(/Playlist snapshot mismatch\. Expected stale, but current snapshot is snap-1\. No changes were made\./);
      expect(fake.mutations, tool).toHaveLength(0);
      await session.close();
      session = undefined;
    }
  });

  it('passes a matching snapshot to Spotify\'s native guard on remove and reorder', async () => {
    const fake = playlistFake();
    session = await startSession(fake);

    await session.call('remove_playlist_items', { playlistId: PLAYLIST, uris: ['spotify:track:e1'], expectedSnapshotId: 'snap-1' });
    expect(fake.mutations[0]).toMatchObject({
      method: 'DELETE',
      body: { items: [{ uri: 'spotify:track:e1' }], snapshot_id: 'snap-1' },
    });

    await session.call('reorder_playlist_items', { playlistId: PLAYLIST, rangeStart: 1, insertBefore: 0, rangeLength: 2, snapshotId: 'snap-1' });
    expect(fake.mutations[1]).toMatchObject({
      method: 'PUT',
      body: { range_start: 1, insert_before: 0, range_length: 2, snapshot_id: 'snap-1' },
    });

    const mismatch = await session.call('remove_playlist_items', {
      playlistId: PLAYLIST, uris: ['spotify:track:e1'], snapshotId: 'a', expectedSnapshotId: 'b',
    });
    expect(mismatch.text).toMatch(/must match when both are provided/);
  });

  it('dryRun never reaches a mutation endpoint on any mutation tool', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['add_playlist_items', { uris: ['spotify:track:n1'] }],
      ['add_unique_playlist_items', { uris: ['spotify:track:n1'] }],
      ['remove_playlist_items', { uris: ['spotify:track:e1'] }],
      ['reorder_playlist_items', { rangeStart: 1, insertBefore: 0 }],
      ['replace_playlist_items', { uris: [] }],
    ];
    const fake = playlistFake();
    session = await startSession(fake);
    for (const [tool, args] of calls) {
      const result = await session.call(tool, { playlistId: PLAYLIST, dryRun: true, ...args });
      expect(result.isError, tool).toBe(false);
      expect(result.json.dryRun, tool).toBe(true);
    }
    expect(fake.mutations).toHaveLength(0);
  });

  it('replace_playlist_items sends the full replacement list and accepts an empty list', async () => {
    const fake = playlistFake();
    session = await startSession(fake);
    await session.call('replace_playlist_items', { playlistId: PLAYLIST, uris: ['spotify:episode:ep1', 'spotify:track:t1'] });
    await session.call('replace_playlist_items', { playlistId: PLAYLIST, uris: [] });
    expect(fake.mutations.map((request) => request.body)).toEqual([
      { uris: ['spotify:episode:ep1', 'spotify:track:t1'] },
      { uris: [] },
    ]);
  });

  it('enforces URI validation and the 100-item bound at the MCP boundary', async () => {
    const fake = playlistFake();
    session = await startSession(fake);

    const tooMany = Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`);
    for (const tool of ['add_playlist_items', 'add_unique_playlist_items', 'remove_playlist_items', 'replace_playlist_items']) {
      expect((await session.call(tool, { playlistId: PLAYLIST, uris: tooMany })).isError, tool).toBe(true);
    }
    const bad = await session.call('add_unique_playlist_items', { playlistId: PLAYLIST, uris: ['https://open.spotify.com/track/abc'] });
    expect(bad.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('add_liked_tracks stays track-only, bounded at 40, and skips tracks already saved', async () => {
    const fake = new FakeSpotify()
      .on('GET', '/me/library/contains', [true, false])
      .on('PUT', '/me/library', undefined);
    session = await startSession(fake);

    const result = await session.call('add_liked_tracks', { uris: ['spotify:track:a1', 'spotify:track:b2'] });
    expect(result.json).toEqual({ addedUris: ['spotify:track:b2'], alreadySavedUris: ['spotify:track:a1'] });
    expect(fake.mutations).toHaveLength(1);
    expect(fake.mutations[0].query.get('uris')).toBe('spotify:track:b2');

    expect((await session.call('add_liked_tracks', { uris: ['spotify:episode:e1'] })).isError).toBe(true);
    const tooMany = Array.from({ length: 41 }, (_, i) => `spotify:track:t${i}`);
    expect((await session.call('add_liked_tracks', { uris: tooMany })).isError).toBe(true);

    const dry = await session.call('add_liked_tracks', { uris: ['spotify:track:a1', 'spotify:track:b2'], dryRun: true });
    expect(dry.json).toMatchObject({ dryRun: true, addedUris: ['spotify:track:b2'] });
    expect(fake.mutations).toHaveLength(1);
  });

  it('reports Spotify errors as tool errors without leaking credentials', async () => {
    const fake = new FakeSpotify().on('GET', '/search', { status: 500, body: { error: { status: 500, message: 'boom' } } });
    session = await startSession(fake);
    const result = await session.call('search_tracks', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Spotify API 500: boom/);
    expect(result.text).not.toMatch(/refresh-token-value|client-secret-value|token-1/);
  });
});

describe('OpenCode configuration', () => {
  const parseJsonc = (path: string) =>
    JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''));

  it.each(['opencode.example.jsonc', 'opencode.jsonc'])('%s still defines the local stdio server', (file) => {
    const config = parseJsonc(file);
    const server = config.mcp['spotify-playlists']; // documented shape: mcp.<name>, not mcp.servers.<name>
    expect(server.type).toBe('local');
    expect(server.command[0]).toBe('node');
    expect(server.command[1]).toMatch(/dist[\\/]server\.js$/);
  });
});
