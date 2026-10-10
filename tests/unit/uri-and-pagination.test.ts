import { describe, expect, it } from 'vitest';
import { collectPages } from '../../src/utils/pagination.js';
import {
  chunk,
  dedupePreservingOrder,
  idFromUri,
  isPlaylistItemUri,
  isTrackUri,
  spotifyIdSchema,
  spotifyPlaylistItemUriSchema,
  spotifyTrackUriSchema,
} from '../../src/utils/uri.js';

describe('Spotify URI validation', () => {
  it('accepts track and episode URIs for playlist items', () => {
    expect(spotifyPlaylistItemUriSchema.safeParse('spotify:track:abc123').success).toBe(true);
    expect(spotifyPlaylistItemUriSchema.safeParse('spotify:episode:abc123').success).toBe(true);
  });

  it.each([
    'https://open.spotify.com/track/abc123',
    'spotify:album:abc123',
    'spotify:track:',
    'spotify:track:abc 123',
    'spotify:local:artist:album:title:100',
    '',
  ])('rejects %j as a playlist item URI', (value) => {
    expect(spotifyPlaylistItemUriSchema.safeParse(value).success).toBe(false);
  });

  it('keeps Liked Songs track-only', () => {
    expect(spotifyTrackUriSchema.safeParse('spotify:track:abc123').success).toBe(true);
    expect(spotifyTrackUriSchema.safeParse('spotify:episode:abc123').success).toBe(false);
    expect(isTrackUri('spotify:episode:abc')).toBe(false);
    expect(isPlaylistItemUri('spotify:episode:abc')).toBe(true);
  });

  it('rejects URLs where an ID is expected', () => {
    expect(spotifyIdSchema.safeParse('37i9dQZF1DXcBWIGoYBM5M').success).toBe(true);
    expect(spotifyIdSchema.safeParse('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M').success).toBe(false);
    expect(spotifyIdSchema.safeParse('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M').success).toBe(false);
  });

  it('extracts IDs from URIs', () => {
    expect(idFromUri('spotify:track:abc123')).toBe('abc123');
    expect(idFromUri('not-a-uri')).toBeUndefined();
  });
});

describe('list helpers', () => {
  it('dedupes while preserving first-seen order and reports repeats', () => {
    expect(dedupePreservingOrder(['a', 'b', 'a', 'c', 'b'])).toEqual({
      unique: ['a', 'b', 'c'],
      duplicates: ['a', 'b'],
    });
  });

  it('chunks into bounded batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
    const batches = chunk(Array.from({ length: 250 }, (_, i) => i), 100);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
  });
});

describe('collectPages', () => {
  const makeFetch = (total: number, pageCalls: Array<[number, number]> = []) =>
    async (offset: number, limit: number) => {
      pageCalls.push([offset, limit]);
      const items = Array.from({ length: Math.max(Math.min(limit, total - offset), 0) }, (_, i) => offset + i);
      return { items, total, next: offset + limit < total ? 'more' : null };
    };

  it('reads to the end when under the cap', async () => {
    const calls: Array<[number, number]> = [];
    const result = await collectPages(makeFetch(120, calls), { offset: 0, pageSize: 50, maxItems: 1000 });
    expect(result.items).toHaveLength(120);
    expect(result.nextOffset).toBeUndefined();
    expect(result.total).toBe(120);
    expect(calls).toEqual([[0, 50], [50, 50], [100, 50]]);
  });

  it('stops exactly at maxItems and reports where to continue', async () => {
    const calls: Array<[number, number]> = [];
    const result = await collectPages(makeFetch(500, calls), { offset: 10, pageSize: 50, maxItems: 75 });
    expect(result.items).toHaveLength(75);
    expect(result.nextOffset).toBe(85);
    expect(calls).toEqual([[10, 50], [60, 25]]);
  });

  it('handles an exact page boundary without a spurious extra request', async () => {
    const calls: Array<[number, number]> = [];
    const result = await collectPages(makeFetch(100, calls), { offset: 0, pageSize: 50, maxItems: 1000 });
    expect(result.items).toHaveLength(100);
    expect(calls).toHaveLength(2);
    expect(result.nextOffset).toBeUndefined();
  });

  it('handles an empty result', async () => {
    const result = await collectPages(makeFetch(0), { offset: 0, pageSize: 50, maxItems: 100 });
    expect(result.items).toEqual([]);
    expect(result.requests).toBe(1);
  });

  it('never loops when Spotify reports a next page but returns no items', async () => {
    let calls = 0;
    const result = await collectPages(
      async () => {
        calls += 1;
        return { items: [], next: 'more', total: 10 };
      },
      { offset: 0, pageSize: 50, maxItems: 100 },
    );
    expect(calls).toBe(1);
    expect(result.items).toEqual([]);
  });
});
