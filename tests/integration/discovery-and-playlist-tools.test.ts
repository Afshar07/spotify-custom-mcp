import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeSpotify,
  itemFixture,
  pagedRoute,
  playlistFixture,
  startSession,
  trackFixture,
  type McpTestSession,
} from '../helpers/fake-spotify.js';

const NEW_TOOLS = [
  'list_my_playlists',
  'create_playlist',
  'update_playlist_details',
  'get_top_items',
  'get_recently_played',
  'get_liked_tracks',
  'get_artist_albums',
  'get_album_tracks',
  'generate_playlist',
  'analyze_playlist',
  'compare_playlists',
  'suggest_playlist_flow',
];

let session: McpTestSession | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
});

const meFake = () => new FakeSpotify().on('GET', '/me', { id: 'me-user', display_name: 'Me' });

describe('tool registration and input validation', () => {
  it('registers every new tool next to the nine original ones', async () => {
    session = await startSession(meFake());
    const names = await session.toolNames();
    for (const tool of NEW_TOOLS) {
      expect(names, tool).toContain(tool);
    }
    expect(names).toHaveLength(21);
  });

  it('gives every tool a description and an object input schema', async () => {
    session = await startSession(meFake());
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(20);
      expect(tool.inputSchema.type, tool.name).toBe('object');
    }
  });

  it('marks dry-run defaults: curation tools default to a preview, others do not', async () => {
    session = await startSession(meFake());
    const { tools } = await session.client.listTools();
    const dryRunDefault = (name: string) =>
      (tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { default?: unknown }>).dryRun.default;
    expect(dryRunDefault('generate_playlist')).toBe(true);
    expect(dryRunDefault('suggest_playlist_flow')).toBe(true);
    expect(dryRunDefault('create_playlist')).toBe(false);
  });

  it('can leave tools unregistered via disabledTools', async () => {
    session = await startSession(meFake(), { disabledTools: ['get_top_items', 'search_tracks'] });
    const names = await session.toolNames();
    expect(names).not.toContain('get_top_items');
    expect(names).not.toContain('search_tracks');
    expect(names).toContain('get_recently_played');
    expect(names).toHaveLength(19);
  });

  it.each([
    ['get_top_items', { type: 'songs' }],
    ['get_top_items', { type: 'tracks', limit: 51 }],
    ['get_top_items', { type: 'tracks', timeRange: 'forever' }],
    ['get_recently_played', { limit: 0 }],
    ['get_liked_tracks', { maxItems: 100000 }],
    ['list_my_playlists', { limit: 51 }],
    ['create_playlist', { name: '' }],
    ['create_playlist', { name: 'x'.repeat(101) }],
    ['create_playlist', { name: 'ok', trackUris: ['spotify:episode:e1'] }],
    ['create_playlist', { name: 'ok', trackUris: Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`) }],
    ['update_playlist_details', { playlistId: 'https://open.spotify.com/playlist/abc', name: 'x' }],
    ['get_artist_albums', { artistId: 'abc', includeGroups: ['everything'] }],
    ['get_artist_albums', { artistId: 'abc', limit: 51 }],
    ['get_album_tracks', { albumId: 'spotify:album:abc' }],
    ['compare_playlists', { playlistIdA: 'abc' }],
    ['suggest_playlist_flow', { playlistId: 'abc', strategy: 'shuffle' }],
    ['generate_playlist', { name: 'x', targetTrackCount: 101 }],
    ['generate_playlist', { name: 'x', candidateTrackUris: ['https://open.spotify.com/track/abc'] }],
  ])('rejects invalid input for %s %j without calling Spotify', async (tool, args) => {
    const fake = meFake();
    session = await startSession(fake);
    const result = await session.call(tool, args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('missing OAuth scopes', () => {
  it.each([
    ['get_top_items', { type: 'tracks' }, 'user-top-read'],
    ['get_recently_played', {}, 'user-read-recently-played'],
    ['get_liked_tracks', {}, 'user-library-read'],
    ['list_my_playlists', {}, 'playlist-read-private'],
    ['create_playlist', { name: 'New', public: true }, 'playlist-modify-public'],
  ])('%s fails with a clear scope error and sends no API request', async (tool, args, scope) => {
    const fake = meFake().on('GET', /.*/, {});
    fake.tokenOptions = { scope: 'playlist-modify-private' };
    session = await startSession(fake);

    const result = await session.call(tool, args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(scope);
    expect(result.text).toMatch(/npm run auth/);
    const apiRequests = fake.requests.filter((request) => request.path !== '/me');
    expect(apiRequests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });

  it('leaves unrelated tools working when one feature lacks permission', async () => {
    const fake = new FakeSpotify().on('GET', '/search', { tracks: { items: [trackFixture('s1')] } });
    fake.tokenOptions = { scope: 'playlist-modify-private' };
    session = await startSession(fake);
    expect((await session.call('get_top_items', { type: 'tracks' })).isError).toBe(true);
    expect((await session.call('search_tracks', { query: 'x' })).isError).toBe(false);
  });
});

describe('list_my_playlists', () => {
  const playlists = [
    playlistFixture('p1', 'Road Trip', 'me-user', { items: { total: 12 }, public: true }),
    playlistFixture('p2', 'Road Songs From Friend', 'other-user', { items: undefined, tracks: { total: 3 } }),
    playlistFixture('p3', 'Focus', 'me-user', { items: { total: 40 }, description: 'deep work' }),
    playlistFixture('p4', 'Road Rage', 'me-user', { collaborative: true }),
  ];

  it('returns one compact page without filters', async () => {
    const fake = meFake().on('GET', '/me/playlists', pagedRoute(playlists));
    session = await startSession(fake);

    const result = await session.call('list_my_playlists', { limit: 2 });
    expect(result.json.total).toBe(4);
    expect(result.json.nextOffset).toBe(2);
    expect(result.json.playlists[0]).toEqual({
      id: 'p1',
      name: 'Road Trip',
      owner: 'me-user',
      ownerId: 'me-user',
      public: true,
      itemCount: 12,
      url: 'https://open.spotify.com/playlist/p1',
    });
    expect(result.json.playlists[1].itemCount).toBe(3); // legacy `tracks.total` fallback
    expect(fake.requestsTo('GET', '/me/playlists')).toHaveLength(1);
  });

  it('filters by name and ownership across pages and reports where to continue', async () => {
    const fake = meFake().on('GET', '/me/playlists', pagedRoute(playlists));
    session = await startSession(fake);

    const first = await session.call('list_my_playlists', { nameFilter: 'road', ownedOnly: true, limit: 1 });
    expect(first.json.playlists.map((playlist: { id: string }) => playlist.id)).toEqual(['p1']);
    expect(first.json.nextOffset).toBe(1);

    const next = await session.call('list_my_playlists', { nameFilter: 'road', ownedOnly: true, limit: 5, offset: first.json.nextOffset });
    expect(next.json.playlists.map((playlist: { id: string; collaborative?: boolean }) => playlist.id)).toEqual(['p4']);
    expect(next.json.playlists[0].collaborative).toBe(true);
    expect(next.json.nextOffset).toBeUndefined();
  });

  it('keeps scanning in bounded pages when matches are sparse', async () => {
    const many = Array.from({ length: 120 }, (_, i) => playlistFixture(`x${i}`, i === 110 ? 'Needle' : `Hay ${i}`));
    const fake = meFake().on('GET', '/me/playlists', pagedRoute(many));
    session = await startSession(fake);
    const result = await session.call('list_my_playlists', { nameFilter: 'needle', limit: 5 });
    expect(result.json.playlists.map((playlist: { id: string }) => playlist.id)).toEqual(['x110']);
    expect(fake.requestsTo('GET', '/me/playlists').map((request) => request.query.get('limit'))).toEqual(['50', '50', '50']);
  });
});

describe('create_playlist', () => {
  function createFake(existing: unknown[] = []) {
    return meFake()
      .on('GET', '/me/playlists', pagedRoute(existing))
      .on('POST', '/me/playlists', ({ body }) => playlistFixture('new1', (body as { name: string }).name, 'me-user', { public: (body as { public: boolean }).public, snapshot_id: 's0' }))
      .on('POST', '/playlists/new1/items', { snapshot_id: 's1' });
  }

  it('dry run previews and never calls a mutation endpoint', async () => {
    const fake = createFake();
    session = await startSession(fake);
    const result = await session.call('create_playlist', {
      name: '  Night Drive ',
      description: 'synth',
      trackUris: ['spotify:track:a1', 'spotify:track:a1', 'spotify:track:b2'],
      dryRun: true,
    });
    expect(result.json).toMatchObject({
      dryRun: true,
      created: false,
      preview: { name: 'Night Drive', description: 'synth', public: false },
      population: { addedUris: ['spotify:track:a1', 'spotify:track:b2'], skippedDuplicateUris: ['spotify:track:a1'] },
    });
    expect(fake.mutations).toHaveLength(0);
  });

  it('creates a private playlist via POST /me/playlists and populates it', async () => {
    const fake = createFake();
    session = await startSession(fake);
    const result = await session.call('create_playlist', {
      name: 'Night Drive',
      description: 'synth',
      trackUris: ['spotify:track:a1', 'spotify:track:b2', 'spotify:track:a1'],
    });

    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({
      created: true,
      playlist: { id: 'new1', name: 'Night Drive', public: false, url: 'https://open.spotify.com/playlist/new1', snapshotId: 's1' },
      population: { addedUris: ['spotify:track:a1', 'spotify:track:b2'], skippedDuplicateUris: ['spotify:track:a1'] },
    });
    expect(fake.mutations.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /me/playlists',
      'POST /playlists/new1/items',
    ]);
    expect(fake.mutations[0].body).toEqual({ name: 'Night Drive', public: false, description: 'synth' });
    expect(fake.mutations[1].body).toEqual({ uris: ['spotify:track:a1', 'spotify:track:b2'] });
    expect(fake.requests.some((request) => request.path.startsWith('/users/'))).toBe(false);
  });

  it('supports public playlists and creating without tracks', async () => {
    const fake = createFake();
    session = await startSession(fake);
    const result = await session.call('create_playlist', { name: 'Open', public: true });
    expect(result.json.playlist.public).toBe(true);
    expect(fake.mutations).toHaveLength(1);
    expect(fake.mutations[0].body).toEqual({ name: 'Open', public: true });
  });

  it('refuses to create a second playlist with the same name unless allowed', async () => {
    const fake = createFake([playlistFixture('old1', 'Night Drive', 'me-user'), playlistFixture('o2', 'Night Drive', 'other-user')]);
    session = await startSession(fake);

    const blocked = await session.call('create_playlist', { name: 'night drive' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/already own 1 playlist\(s\) named "night drive" \(first ID: old1\)/);
    expect(fake.mutations).toHaveLength(0);

    const dry = await session.call('create_playlist', { name: 'Night Drive', dryRun: true });
    expect(dry.json.existingSameNamePlaylists).toHaveLength(1);
    expect(fake.mutations).toHaveLength(0);

    const allowed = await session.call('create_playlist', { name: 'Night Drive', allowDuplicateName: true });
    expect(allowed.json.created).toBe(true);
  });

  it('reports a partially populated playlist instead of hiding it, and never retries creation', async () => {
    const fake = meFake()
      .on('GET', '/me/playlists', pagedRoute([]))
      .on('POST', '/me/playlists', playlistFixture('new1', 'Half', 'me-user'))
      .on('POST', '/playlists/new1/items', { status: 500, body: { error: { status: 500, message: 'server error' } } });
    session = await startSession(fake);

    const result = await session.call('create_playlist', { name: 'Half', trackUris: ['spotify:track:a1', 'spotify:track:b2'] });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      created: true,
      playlist: { id: 'new1' },
      population: { addedUris: [], failed: { uris: ['spotify:track:a1', 'spotify:track:b2'] } },
    });
    expect(result.json.population.failed.error).toMatch(/Spotify API 500/);
    expect(result.json.warnings.join(' ')).toMatch(/playlist was created, but adding tracks failed/);
    expect(fake.requestsTo('POST', '/me/playlists')).toHaveLength(1);
    expect(fake.requestsTo('POST', '/playlists/new1/items')).toHaveLength(1);
  });

  it('does not retry playlist creation when Spotify answers 5xx', async () => {
    const fake = meFake()
      .on('GET', '/me/playlists', pagedRoute([]))
      .on('POST', '/me/playlists', { status: 502, body: { error: { status: 502, message: 'bad gateway' } } });
    session = await startSession(fake);
    const result = await session.call('create_playlist', { name: 'Once' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/may or may not have been applied/);
    expect(fake.requestsTo('POST', '/me/playlists')).toHaveLength(1);
  });

  it('still creates when the same-name check lacks permission, with a warning', async () => {
    const fake = meFake()
      .on('GET', '/me/playlists', { status: 403, body: { error: { status: 403, message: 'Forbidden' } } })
      .on('POST', '/me/playlists', playlistFixture('new1', 'Warn', 'me-user'));
    session = await startSession(fake);
    const result = await session.call('create_playlist', { name: 'Warn' });
    expect(result.json.created).toBe(true);
    expect(result.json.warnings.join(' ')).toMatch(/Could not check for existing playlists/);
  });
});

describe('update_playlist_details', () => {
  const owned = playlistFixture('pl1', 'Old name', 'me-user', { description: 'old', public: false });

  it('rejects an empty update', async () => {
    const fake = meFake();
    session = await startSession(fake);
    const result = await session.call('update_playlist_details', { playlistId: 'pl1' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/at least one of name, description, or public/);
    expect(fake.requests).toHaveLength(0);
  });

  it('previews the field changes on a dry run without sending PUT', async () => {
    const fake = meFake().on('GET', '/playlists/pl1', owned);
    session = await startSession(fake);
    const result = await session.call('update_playlist_details', { playlistId: 'pl1', name: 'New name', public: true, dryRun: true });
    expect(result.json).toEqual({
      playlistId: 'pl1',
      dryRun: true,
      updated: false,
      changes: { name: { from: 'Old name', to: 'New name' }, public: { from: false, to: true } },
    });
    expect(fake.mutations).toHaveLength(0);
  });

  it('sends only the changed fields', async () => {
    const fake = meFake().on('GET', '/playlists/pl1', owned).on('PUT', '/playlists/pl1', undefined);
    session = await startSession(fake);
    const result = await session.call('update_playlist_details', { playlistId: 'pl1', name: 'Old name', description: 'fresh' });
    expect(result.json).toMatchObject({ updated: true, changes: { description: { from: 'old', to: 'fresh' } } });
    expect(fake.mutations).toHaveLength(1);
    expect(fake.mutations[0].body).toEqual({ description: 'fresh' });
  });

  it('does nothing when the playlist already matches', async () => {
    const fake = meFake().on('GET', '/playlists/pl1', owned);
    session = await startSession(fake);
    const result = await session.call('update_playlist_details', { playlistId: 'pl1', name: 'Old name' });
    expect(result.json).toMatchObject({ updated: false });
    expect(fake.mutations).toHaveLength(0);
  });

  it('refuses to edit a playlist owned by someone else', async () => {
    const fake = meFake().on('GET', '/playlists/pl2', playlistFixture('pl2', 'Theirs', 'other-user'));
    session = await startSession(fake);
    const result = await session.call('update_playlist_details', { playlistId: 'pl2', name: 'Mine now' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/do not own this playlist/);
    expect(fake.mutations).toHaveLength(0);
  });

  it('surfaces a Spotify permission failure', async () => {
    const fake = meFake()
      .on('GET', '/playlists/pl1', owned)
      .on('PUT', '/playlists/pl1', { status: 403, body: { error: { status: 403, message: 'Forbidden' } } });
    session = await startSession(fake);
    const result = await session.call('update_playlist_details', { playlistId: 'pl1', name: 'New' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Spotify API 403/);
  });
});

describe('listening-history and library tools', () => {
  it('get_top_items reads tracks with time range and paging', async () => {
    const fake = meFake().on('GET', '/me/top/tracks', pagedRoute([trackFixture('t1', 'One'), trackFixture('t2', 'Two')]));
    session = await startSession(fake);
    const result = await session.call('get_top_items', { type: 'tracks', timeRange: 'short_term', limit: 1, offset: 1 });

    expect(fake.requests[fake.requests.length - 1].query.get('time_range')).toBe('short_term');
    expect(result.json).toMatchObject({ type: 'tracks', timeRange: 'short_term', total: 2, offset: 1 });
    expect(result.json.items).toEqual([
      expect.objectContaining({ id: 't2', uri: 'spotify:track:t2', name: 'Two', artists: ['Artist One'], url: 'https://open.spotify.com/track/t2' }),
    ]);
  });

  it('get_top_items reads artists without assuming popularity or followers', async () => {
    const artists = [{ id: 'ar1', uri: 'spotify:artist:ar1', name: 'Band', genres: ['rock'], external_urls: { spotify: 'https://open.spotify.com/artist/ar1' } }];
    const fake = meFake().on('GET', '/me/top/artists', pagedRoute(artists));
    session = await startSession(fake);
    const result = await session.call('get_top_items', { type: 'artists' });
    expect(fake.requests[fake.requests.length - 1].query.get('time_range')).toBe('medium_term');
    expect(result.json.items).toEqual([{ id: 'ar1', uri: 'spotify:artist:ar1', name: 'Band', genres: ['rock'], url: 'https://open.spotify.com/artist/ar1' }]);
  });

  it('get_recently_played returns timestamps, passes cursors, and states its limits', async () => {
    const fake = meFake().on('GET', '/me/player/recently-played', {
      items: [
        { played_at: '2025-01-01T10:00:00Z', track: trackFixture('r1', 'Recent') },
        { played_at: '2025-01-01T09:00:00Z', track: null },
      ],
      cursors: { after: '1735725600000', before: '1735722000000' },
    });
    session = await startSession(fake);

    const result = await session.call('get_recently_played', { limit: 5, before: 1735729200000 });
    const request = fake.requests[fake.requests.length - 1];
    expect(request.query.get('limit')).toBe('5');
    expect(request.query.get('before')).toBe('1735729200000');
    expect(request.query.has('after')).toBe(false);
    expect(result.json.count).toBe(1);
    expect(result.json.items[0]).toMatchObject({ playedAt: '2025-01-01T10:00:00Z', uri: 'spotify:track:r1' });
    expect(result.json.cursors).toEqual({ after: '1735725600000', before: '1735722000000' });
    expect(result.json.note).toMatch(/not complete listening history/);
  });

  it('get_recently_played rejects after and before together', async () => {
    const fake = meFake();
    session = await startSession(fake);
    const result = await session.call('get_recently_played', { after: 1, before: 2 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/only one of/);
    expect(fake.requests).toHaveLength(0);
  });

  const liked = Array.from({ length: 120 }, (_, i) => ({
    added_at: '2025-01-01T00:00:00Z',
    track: trackFixture(`l${i}`, i === 7 ? 'Special Song' : `Liked ${i}`, { artists: [i === 7 ? 'Rare Band' : 'Common'] }),
  }));

  it('get_liked_tracks stays bounded by maxItems and reports how to continue', async () => {
    const fake = meFake().on('GET', '/me/tracks', pagedRoute(liked));
    session = await startSession(fake);
    const result = await session.call('get_liked_tracks', { maxItems: 75 });

    expect(result.json).toMatchObject({ total: 120, offset: 0, retrieved: 75, nextOffset: 75 });
    expect(result.json.items).toHaveLength(75);
    expect(result.json.items[0].addedAt).toBe('2025-01-01T00:00:00Z');
    expect(fake.requestsTo('GET', '/me/tracks').map((request) => request.query.get('limit'))).toEqual(['50', '25']);
  });

  it('get_liked_tracks filters only what it retrieved', async () => {
    const fake = meFake().on('GET', '/me/tracks', pagedRoute(liked));
    session = await startSession(fake);
    const hit = await session.call('get_liked_tracks', { maxItems: 50, query: 'rare band' });
    expect(hit.json.matched).toBe(1);
    expect(hit.json.items[0].name).toBe('Special Song');

    const miss = await session.call('get_liked_tracks', { maxItems: 5, query: 'rare band' });
    expect(miss.json.matched).toBe(0);
    expect(miss.json.retrieved).toBe(5);
  });

  it('get_liked_tracks reads to the end of a small library in one pass', async () => {
    const fake = meFake().on('GET', '/me/tracks', pagedRoute(liked.slice(0, 30)));
    session = await startSession(fake);
    const result = await session.call('get_liked_tracks', {});
    expect(result.json.retrieved).toBe(30);
    expect(result.json.nextOffset).toBeUndefined();
    expect(fake.requestsTo('GET', '/me/tracks')).toHaveLength(1);
  });
});

describe('artist and album discovery', () => {
  const album = (id: string, name: string, releaseDate: string, type = 'album') => ({
    id,
    uri: `spotify:album:${id}`,
    name,
    album_type: type,
    release_date: releaseDate,
    total_tracks: 10,
    artists: [{ id: 'ar1', name: 'Band', uri: 'spotify:artist:ar1' }],
    external_urls: { spotify: `https://open.spotify.com/album/${id}` },
  });

  it('get_artist_albums passes filters and collapses editions', async () => {
    const albums = [
      album('a1', 'Second Record (Deluxe Edition)', '2022-05-01'),
      album('a2', 'Second Record', '2020-01-01'),
      album('a3', 'Second Record - 2011 Remaster', '2021-01-01'),
      album('a4', 'First Record', '2018-01-01'),
      album('a5', 'First Record', '2018-01-01', 'single'),
    ];
    const fake = meFake().on('GET', '/artists/ar1/albums', pagedRoute(albums));
    session = await startSession(fake);

    const result = await session.call('get_artist_albums', {
      artistId: 'ar1',
      includeGroups: ['album', 'single'],
      market: 'us',
      limit: 10,
    });
    const request = fake.requests[fake.requests.length - 1];
    expect(request.query.get('include_groups')).toBe('album,single');
    expect(request.query.get('market')).toBe('US');
    expect(result.json.editionsCollapsed).toBe(2);
    expect(result.json.items.map((item: { id: string }) => item.id)).toEqual(['a2', 'a4', 'a5']);
    expect(result.json.items[0]).toMatchObject({ collapsedEditions: 2, releaseDate: '2020-01-01', artists: ['Band'] });
  });

  it('get_artist_albums can return every edition', async () => {
    const albums = [album('a1', 'Record (Deluxe)', '2022-05-01'), album('a2', 'Record', '2020-01-01')];
    session = await startSession(meFake().on('GET', '/artists/ar1/albums', pagedRoute(albums)));
    const result = await session.call('get_artist_albums', { artistId: 'ar1', dedupeEditions: false });
    expect(result.json.items).toHaveLength(2);
    expect(result.json.editionsCollapsed).toBe(0);
  });

  it('get_artist_albums reports where to continue', async () => {
    const albums = Array.from({ length: 5 }, (_, i) => album(`a${i}`, `Record ${i}`, '2020-01-01'));
    session = await startSession(meFake().on('GET', '/artists/ar1/albums', pagedRoute(albums)));
    const result = await session.call('get_artist_albums', { artistId: 'ar1', limit: 2 });
    expect(result.json).toMatchObject({ total: 5, nextOffset: 2 });
  });

  it('get_album_tracks returns exact URIs and track metadata', async () => {
    const tracks = [
      { id: 't1', uri: 'spotify:track:t1', name: 'Intro', duration_ms: 61000, track_number: 1, disc_number: 1, explicit: false, artists: [{ id: 'ar1', name: 'Band', uri: 'spotify:artist:ar1' }], external_urls: { spotify: 'https://open.spotify.com/track/t1' } },
      { id: 't2', uri: 'spotify:track:t2', name: 'Loud', duration_ms: 200000, track_number: 2, disc_number: 1, explicit: true, artists: [] },
    ];
    const fake = meFake().on('GET', '/albums/al1/tracks', pagedRoute(tracks));
    session = await startSession(fake);
    const result = await session.call('get_album_tracks', { albumId: 'al1', market: 'de', limit: 1 });

    expect(fake.requests[fake.requests.length - 1].query.get('market')).toBe('DE');
    expect(result.json).toMatchObject({ total: 2, offset: 0, nextOffset: 1 });
    expect(result.json.items[0]).toEqual({
      id: 't1', uri: 'spotify:track:t1', name: 'Intro', artists: ['Band'], durationMs: 61000,
      trackNumber: 1, discNumber: 1, explicit: false, url: 'https://open.spotify.com/track/t1',
    });
  });

  it('surfaces an unknown artist as a tool error', async () => {
    session = await startSession(meFake().on('GET', '/artists/missing/albums', { status: 404, body: { error: { status: 404, message: 'Non existing id' } } }));
    const result = await session.call('get_artist_albums', { artistId: 'missing' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Spotify API 404: Non existing id/);
  });
});

// Kept to exercise the shared fixtures used by other suites.
describe('fixtures', () => {
  it('builds playlist items the client can read', () => {
    expect(itemFixture(trackFixture('x')).item?.uri).toBe('spotify:track:x');
  });
});
