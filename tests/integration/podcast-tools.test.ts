import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeSpotify,
  pagedRoute,
  startSession,
  type McpTestSession,
} from '../helpers/fake-spotify.js';

let session: McpTestSession | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
});

const PODCAST_TOOLS = [
  'search_podcasts',
  'search_episodes',
  'get_podcast_details',
  'get_podcast_episodes',
  'get_saved_episodes',
  'get_saved_podcasts',
  'save_episode',
];

const showFixture = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  uri: `spotify:show:${id}`,
  name: `Show ${id}`,
  description: 'About software architecture',
  total_episodes: 120,
  explicit: false,
  languages: ['en'],
  images: [{ url: `https://img/${id}.jpg`, height: 640, width: 640 }],
  external_urls: { spotify: `https://open.spotify.com/show/${id}` },
  ...extra,
});

const episodeFixture = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  uri: `spotify:episode:${id}`,
  name: `Episode ${id}`,
  description: 'Talking about Nuxt',
  duration_ms: 1_800_000,
  release_date: '2024-03-01',
  explicit: false,
  is_playable: true,
  external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
  ...extra,
});

const searchPage = (key: 'shows' | 'episodes', items: unknown[]) => ({
  [key]: { href: '', items, limit: 5, offset: 0, next: null, previous: null, total: items.length },
});

describe('podcast tool registration', () => {
  it('registers podcast tools alongside all 21 existing tools', async () => {
    session = await startSession(new FakeSpotify());
    const names = await session.toolNames();
    for (const tool of PODCAST_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names).toHaveLength(28);
  });

  it('defaults save_episode to dryRun and caps search at 10', async () => {
    session = await startSession(new FakeSpotify());
    const { tools } = await session.client.listTools();
    const props = (name: string) =>
      (tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, any> }).properties;
    expect(props('save_episode').dryRun).toMatchObject({ default: true });
    expect(props('search_podcasts').limit).toMatchObject({ maximum: 10, default: 5 });
    expect(props('search_episodes').limit).toMatchObject({ maximum: 10 });
  });
});

describe('search tools', () => {
  it('search_podcasts uses type=show, omits null results and tolerates missing fields', async () => {
    const fake = new FakeSpotify().on('GET', '/search', searchPage('shows', [showFixture('s1'), null, { id: 's2', uri: 'spotify:show:s2', name: 'Bare' }]));
    session = await startSession(fake);
    const result = await session.call('search_podcasts', { query: 'ai coding', market: 'us' });
    expect(result.isError).toBe(false);
    expect(result.json.unavailable).toBe(1);
    expect(result.json.items).toHaveLength(2);
    expect(result.json.items[0]).toMatchObject({ id: 's1', uri: 'spotify:show:s1', totalEpisodes: 120, url: 'https://open.spotify.com/show/s1' });
    expect(result.json.items[1]).toEqual({ id: 's2', uri: 'spotify:show:s2', name: 'Bare' });
    const request = fake.requestsTo('GET', '/search')[0];
    expect(request.query.get('type')).toBe('show');
    expect(request.query.get('market')).toBe('US');
    expect(request.query.get('limit')).toBe('5');
  });

  it('search_episodes uses type=episode and flags restricted episodes', async () => {
    const fake = new FakeSpotify().on(
      'GET',
      '/search',
      searchPage('episodes', [
        episodeFixture('e1', { show: showFixture('s1') }),
        episodeFixture('e2', { is_playable: false, restrictions: { reason: 'market' } }),
      ]),
    );
    session = await startSession(fake);
    const result = await session.call('search_episodes', { query: 'vue', limit: 2 });
    expect(fake.requestsTo('GET', '/search')[0].query.get('type')).toBe('episode');
    expect(result.json.items[0]).toMatchObject({ uri: 'spotify:episode:e1', show: { id: 's1', name: 'Show s1' }, durationMs: 1_800_000 });
    expect(result.json.items[1]).toMatchObject({ playable: false, restriction: 'market' });
  });

  it('rejects out-of-range search input before calling Spotify', async () => {
    const fake = new FakeSpotify();
    session = await startSession(fake);
    for (const args of [{ query: 'x', limit: 11 }, { query: '' }, { query: 'x', market: 'USA' }]) {
      expect((await session.call('search_podcasts', args)).isError).toBe(true);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('show tools', () => {
  const episodes = [
    episodeFixture('e1', { release_date: '2023-01-01' }),
    episodeFixture('e2', { release_date: '2024-06-01' }),
    null,
    episodeFixture('e3', { release_date: '2022-01-01' }),
  ];

  it('get_podcast_episodes pages, sorts only the returned page and fetches show once', async () => {
    const fake = new FakeSpotify()
      .on('GET', '/shows/sh1', showFixture('sh1'))
      .on('GET', '/shows/sh1/episodes', pagedRoute(episodes));
    session = await startSession(fake);
    const result = await session.call('get_podcast_episodes', { showId: 'sh1', limit: 4, sort: 'newest' });
    expect(result.json.show.id).toBe('sh1');
    expect(result.json.episodes.map((e: any) => e.id)).toEqual(['e2', 'e1', 'e3']);
    expect(result.json.sortScope).toBe('returned page only');
    expect(result.json.unavailable).toBe(1);
    expect(fake.requestsTo('GET', '/shows/sh1')).toHaveLength(1);
    expect(fake.requestsTo('GET', '/shows/sh1/episodes')).toHaveLength(1);
  });

  it('continues with nextOffset and can skip show metadata', async () => {
    const many = Array.from({ length: 30 }, (_, i) => episodeFixture(`x${i}`));
    const fake = new FakeSpotify().on('GET', '/shows/sh1/episodes', pagedRoute(many));
    session = await startSession(fake);
    const result = await session.call('get_podcast_episodes', { showId: 'sh1', limit: 10, includeShow: false });
    expect(result.json.nextOffset).toBe(10);
    expect(result.json.show).toBeUndefined();
    expect(fake.requestsTo('GET', '/shows/sh1')).toHaveLength(0);
    expect(fake.requests).toHaveLength(1); // no implicit archive crawl
  });

  it('rejects a URI where a show ID is expected', async () => {
    session = await startSession(new FakeSpotify());
    expect((await session.call('get_podcast_episodes', { showId: 'spotify:show:abc' })).isError).toBe(true);
  });

  it('maps 404 to an unavailable hint', async () => {
    const fake = new FakeSpotify().on('GET', '/shows/gone', { status: 404, body: { error: { status: 404, message: 'Non existing id' } } });
    session = await startSession(fake);
    const result = await session.call('get_podcast_details', { showId: 'gone' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/404/);
    expect(result.text).toMatch(/unavailable in this market/);
  });

  it('get_podcast_details returns compact metadata', async () => {
    const fake = new FakeSpotify().on('GET', '/shows/sh1', showFixture('sh1'));
    session = await startSession(fake);
    const result = await session.call('get_podcast_details', { showId: 'sh1' });
    expect(result.json).toMatchObject({ languages: ['en'], totalEpisodes: 120 });
  });
});

describe('saved podcasts and episodes', () => {
  const saved = [
    { added_at: '2024-05-01T00:00:00Z', episode: episodeFixture('a1', { name: 'Software architecture deep dive', show: showFixture('s1') }) },
    { added_at: '2024-04-01T00:00:00Z', episode: episodeFixture('a2', { name: 'Cooking', description: 'food' }) },
    { added_at: '2024-03-01T00:00:00Z', episode: null },
  ];

  it('get_saved_episodes filters retrieved items and explains limits', async () => {
    const fake = new FakeSpotify().on('GET', '/me/episodes', pagedRoute(saved));
    session = await startSession(fake);
    const result = await session.call('get_saved_episodes', { query: 'architecture' });
    expect(result.json.retrieved).toBe(3);
    expect(result.json.matched).toBe(1);
    expect(result.json.items[0]).toMatchObject({ id: 'a1', savedAt: '2024-05-01T00:00:00Z', show: { id: 's1' } });
    expect(result.json.note).toMatch(/not listening history/);
    expect(fake.mutations).toHaveLength(0);
  });

  it('fails before sending when user-library-read is missing', async () => {
    const fake = new FakeSpotify().on('GET', '/me/episodes', pagedRoute(saved));
    fake.tokenOptions.scope = 'playlist-read-private';
    session = await startSession(fake);
    const result = await session.call('get_saved_episodes');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/user-library-read/);
    expect(fake.requestsTo('GET', '/me/episodes')).toHaveLength(0);
  });

  it('get_saved_podcasts lists saved shows', async () => {
    const fake = new FakeSpotify().on('GET', '/me/shows', pagedRoute([{ added_at: '2024-01-01T00:00:00Z', show: showFixture('s1') }]));
    session = await startSession(fake);
    const result = await session.call('get_saved_podcasts');
    expect(result.json.items[0]).toMatchObject({ id: 's1', savedAt: '2024-01-01T00:00:00Z' });
  });
});

describe('save_episode', () => {
  const containsFor = (savedUris: string[]) => ({ query }: { query: URLSearchParams }) =>
    query.get('uris')!.split(',').map((uri) => savedUris.includes(uri));

  it('dry run reads only and previews what would be saved', async () => {
    const fake = new FakeSpotify()
      .on('GET', '/me/library/contains', containsFor(['spotify:episode:a']))
      .on('PUT', '/me/library', { status: 200 });
    session = await startSession(fake);
    const result = await session.call('save_episode', { episodeUris: ['spotify:episode:a', 'spotify:episode:b'] });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({
      dryRun: true,
      alreadySavedUris: ['spotify:episode:a'],
      newlySavedUris: ['spotify:episode:b'],
      failedUris: [],
    });
    expect(fake.mutations).toHaveLength(0);
  });

  it('saves only missing, deduplicated episodes when dryRun=false', async () => {
    const fake = new FakeSpotify()
      .on('GET', '/me/library/contains', containsFor(['spotify:episode:a']))
      .on('PUT', '/me/library', { status: 200 });
    session = await startSession(fake);
    const result = await session.call('save_episode', {
      episodeUris: ['spotify:episode:a', 'spotify:episode:b', 'spotify:episode:b'],
      dryRun: false,
    });
    expect(result.json.newlySavedUris).toEqual(['spotify:episode:b']);
    expect(result.json.duplicateInputUris).toEqual(['spotify:episode:b']);
    expect(fake.mutations).toHaveLength(1);
    expect(fake.mutations[0].query.get('uris')).toBe('spotify:episode:b');
  });

  it('rejects track URIs and malformed input without any request', async () => {
    const fake = new FakeSpotify();
    session = await startSession(fake);
    expect((await session.call('save_episode', { episodeUris: ['spotify:track:t1'], dryRun: false })).isError).toBe(true);
    expect((await session.call('save_episode', { episodeUris: [] })).isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('requires user-library-modify before writing', async () => {
    const fake = new FakeSpotify()
      .on('GET', '/me/library/contains', containsFor([]))
      .on('PUT', '/me/library', { status: 200 });
    fake.tokenOptions.scope = 'user-library-read';
    session = await startSession(fake);
    const result = await session.call('save_episode', { episodeUris: ['spotify:episode:b'], dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/user-library-modify/);
    expect(fake.mutations).toHaveLength(0);
  });

  it('reports a failed write as failedUris and does not retry it', async () => {
    const fake = new FakeSpotify()
      .on('GET', '/me/library/contains', containsFor([]))
      .on('PUT', '/me/library', { status: 500, body: { error: { status: 500, message: 'oops' } } });
    session = await startSession(fake);
    const result = await session.call('save_episode', { episodeUris: ['spotify:episode:b'], dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.json.failedUris).toHaveLength(1);
    expect(result.json.failedUris[0].reason).toMatch(/may or may not have been applied/);
    expect(result.json.newlySavedUris).toEqual([]);
    expect(fake.requestsTo('PUT', '/me/library')).toHaveLength(1);
  });

  it('honors Retry-After on rate-limited reads then succeeds', async () => {
    let calls = 0;
    const fake = new FakeSpotify().on('GET', '/search', () => {
      calls += 1;
      return calls === 1
        ? { status: 429, headers: { 'retry-after': '1' }, body: { error: { status: 429, message: 'slow' } } }
        : searchPage('shows', [showFixture('s1')]);
    });
    session = await startSession(fake);
    const result = await session.call('search_podcasts', { query: 'x' });
    expect(result.isError).toBe(false);
    expect(calls).toBe(2);
  });

  it('never leaks credentials in responses', async () => {
    const fake = new FakeSpotify().on('GET', '/search', searchPage('shows', [showFixture('s1')]));
    session = await startSession(fake);
    const result = await session.call('search_podcasts', { query: 'x' });
    for (const secret of ['client-secret-value', 'refresh-token-value', 'token-1']) {
      expect(result.text).not.toContain(secret);
    }
  });
});
