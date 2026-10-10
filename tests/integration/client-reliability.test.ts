import { describe, expect, it } from 'vitest';
import { SpotifyApiError, SpotifyScopeError } from '../../src/spotify.js';
import { FakeSpotify, makeClient, trackFixture } from '../helpers/fake-spotify.js';

describe('SpotifyClient reliability', () => {
  it('caps search at Spotify\'s current limit of 10 whatever the caller asks', async () => {
    const fake = new FakeSpotify().on('GET', '/search', { tracks: { items: [trackFixture('s1')] } });
    const client = makeClient(fake);

    await client.searchTracks('anything', 50);
    await client.searchTracks('anything', 0);

    expect(fake.requests.map((request) => request.query.get('limit'))).toEqual(['10', '1']);
    expect(fake.requests[0].query.get('type')).toBe('track');
  });

  it('refreshes an expired access token before the next request', async () => {
    const fake = new FakeSpotify().on('GET', '/me', { id: 'me-user' });
    fake.tokenOptions = { expiresIn: 10 }; // inside the 30s refresh margin: never reusable
    const client = makeClient(fake);

    await client.getCurrentUser();
    await client.getCurrentUser(); // cached user, no second request
    expect(fake.tokenRequests).toBe(1);

    const other = makeClient(fake);
    await other.searchTracks('a').catch(() => undefined);
    await other.searchTracks('b').catch(() => undefined);
    expect(fake.tokenRequests).toBe(3);
  });

  it('reuses a valid token', async () => {
    const fake = new FakeSpotify().on('GET', '/search', { tracks: { items: [] } });
    const client = makeClient(fake);
    await client.searchTracks('a');
    await client.searchTracks('b');
    expect(fake.tokenRequests).toBe(1);
  });

  it('refreshes and retries once after a 401, then reports a persistent 401', async () => {
    let calls = 0;
    const fake = new FakeSpotify().on('GET', '/me', () => {
      calls += 1;
      return calls === 1 ? { status: 401, body: { error: { status: 401, message: 'The access token expired' } } } : { id: 'me-user' };
    });
    const client = makeClient(fake);

    await expect(client.getCurrentUser()).resolves.toEqual({ id: 'me-user' });
    expect(fake.tokenRequests).toBe(2);

    const failing = new FakeSpotify().on('GET', '/search', { status: 401, body: { error: { status: 401, message: 'Invalid token' } } });
    await expect(makeClient(failing).searchTracks('x')).rejects.toThrow(/Spotify API 401: Invalid token/);
    expect(failing.requests).toHaveLength(2);
  });

  it('waits for Retry-After on 429 and then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fake = new FakeSpotify().on('GET', '/search', () => {
      calls += 1;
      return calls <= 2
        ? { status: 429, body: { error: { status: 429, message: 'rate limited' } }, headers: { 'retry-after': '3' } }
        : { tracks: { items: [trackFixture('ok')] } };
    });
    const client = makeClient(fake, { sleep: async (ms) => void sleeps.push(ms) });

    await expect(client.searchTracks('x')).resolves.toHaveLength(1);
    expect(sleeps).toEqual([3000, 3000]);
  });

  it('gives up after bounded 429 retries and surfaces the Retry-After value', async () => {
    const fake = new FakeSpotify().on('GET', '/search', { status: 429, body: {}, headers: { 'retry-after': '2' } });
    const client = makeClient(fake, { maxRateLimitRetries: 2 });

    const error = await client.searchTracks('x').catch((caught) => caught);
    expect(error).toBeInstanceOf(SpotifyApiError);
    expect(error.status).toBe(429);
    expect(error.message).toMatch(/Retry after 2 seconds/);
    expect(fake.requests).toHaveLength(3);
  });

  it('does not wait out an unreasonably long Retry-After', async () => {
    const sleeps: number[] = [];
    const fake = new FakeSpotify().on('GET', '/search', { status: 429, body: {}, headers: { 'retry-after': '3600' } });
    const client = makeClient(fake, { sleep: async (ms) => void sleeps.push(ms) });

    await expect(client.searchTracks('x')).rejects.toThrow(/Retry after 3600 seconds/);
    expect(sleeps).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it('retries 429 on a mutation, because a rate-limited request was not applied', async () => {
    let calls = 0;
    const fake = new FakeSpotify().on('POST', '/playlists/pl1/items', () => {
      calls += 1;
      return calls === 1 ? { status: 429, body: {}, headers: { 'retry-after': '1' } } : { snapshot_id: 'new' };
    });
    await expect(makeClient(fake).addPlaylistItems({ playlistId: 'pl1', uris: ['spotify:track:a'] })).resolves.toEqual({ snapshot_id: 'new' });
    expect(fake.mutations).toHaveLength(2);
  });

  it('retries reads on 5xx but never retries a mutation', async () => {
    let reads = 0;
    const readFake = new FakeSpotify().on('GET', '/search', () => {
      reads += 1;
      return reads < 3 ? { status: 503, body: { error: { status: 503, message: 'unavailable' } } } : { tracks: { items: [] } };
    });
    await expect(makeClient(readFake).searchTracks('x')).resolves.toEqual([]);
    expect(reads).toBe(3);

    const writeFake = new FakeSpotify().on('POST', '/playlists/pl1/items', { status: 500, body: { error: { status: 500, message: 'oops' } } });
    const error = await makeClient(writeFake)
      .addPlaylistItems({ playlistId: 'pl1', uris: ['spotify:track:a'] })
      .catch((caught) => caught);
    expect(error.message).toMatch(/Spotify API 500: oops/);
    expect(error.message).toMatch(/may or may not have been applied/);
    expect(writeFake.mutations).toHaveLength(1);
  });

  it('reports a network failure on a mutation as an uncertain outcome without retrying', async () => {
    let attempts = 0;
    const fake = new FakeSpotify();
    const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('accounts.spotify.com')) {
        return fake.fetch(input, init);
      }
      attempts += 1;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as typeof fetch;

    const client = makeClient(fake, { fetch: failingFetch });
    const error = await client.createPlaylist({ name: 'x', public: false }).catch((caught) => caught);

    expect(attempts).toBe(1);
    expect(error.message).toMatch(/outcome is unknown and the request was not retried/);
    expect(error.message).not.toMatch(/refresh-token-value|client-secret-value|token-1/);
  });

  it('retries timed-out reads a bounded number of times', async () => {
    let attempts = 0;
    const fake = new FakeSpotify();
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('accounts.spotify.com')) {
        return fake.fetch(input, init);
      }
      attempts += 1;
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as typeof fetch;

    await expect(makeClient(fake, { fetch: flaky }).searchTracks('x')).rejects.toThrow(/Spotify request failed \(TimeoutError\)/);
    expect(attempts).toBe(3);
  });

  it('fails before sending when a required scope was not granted', async () => {
    const fake = new FakeSpotify().on('GET', '/me/top/tracks', { items: [] });
    fake.tokenOptions = { scope: 'playlist-modify-private' };
    const client = makeClient(fake);

    const error = await client.getTopTracks('short_term').catch((caught) => caught);
    expect(error).toBeInstanceOf(SpotifyScopeError);
    expect(error.message).toMatch(/user-top-read/);
    expect(error.message).toMatch(/npm run auth/);
    expect(fake.requests).toHaveLength(0);
  });

  it('accepts anyOf scope requirements', async () => {
    const fake = new FakeSpotify().on('PUT', '/playlists/pl1', undefined);
    fake.tokenOptions = { scope: 'playlist-modify-public' };
    await expect(makeClient(fake).updatePlaylistDetails({ playlistId: 'pl1', name: 'n' })).resolves.toBeUndefined();

    const none = new FakeSpotify();
    none.tokenOptions = { scope: 'user-library-read' };
    await expect(makeClient(none).updatePlaylistDetails({ playlistId: 'pl1', name: 'n' })).rejects.toBeInstanceOf(SpotifyScopeError);
  });

  it('explains a 403 as a possible scope or Development Mode access problem', async () => {
    const fake = new FakeSpotify().on('GET', '/playlists/pl1/items', { status: 403, body: { error: { status: 403, message: 'Forbidden' } } });
    const error = await makeClient(fake).getPlaylistItems('pl1').catch((caught) => caught);
    expect(error.message).toMatch(/Spotify API 403: Forbidden/);
    expect(error.message).toMatch(/missing OAuth scope/);
    expect(error.message).toMatch(/Development Mode/);
  });

  it('surfaces 404 with the Spotify message', async () => {
    const fake = new FakeSpotify().on('GET', /^\/playlists\//, { status: 404, body: { error: { status: 404, message: 'Not found' } } });
    await expect(makeClient(fake).getPlaylistSnapshot('nope')).rejects.toThrow('Spotify API 404: Not found');
  });

  it('rejects mutation batches over 100 URIs before sending', async () => {
    const fake = new FakeSpotify();
    const uris = Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`);
    await expect(makeClient(fake).addPlaylistItems({ playlistId: 'pl1', uris })).rejects.toThrow(/at most 100 URIs/);
    await expect(makeClient(fake).replacePlaylistItems({ playlistId: 'pl1', uris })).rejects.toThrow(/at most 100 URIs/);
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects after and before together for recently played', async () => {
    const fake = new FakeSpotify();
    await expect(makeClient(fake).getRecentlyPlayed({ after: 1, before: 2 })).rejects.toThrow(/only one of/);
  });
});
