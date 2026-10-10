import { describe, expect, it, vi } from 'vitest';
import { EPodcastSort } from '../../src/models/podcast.js';
import {
  filterEpisodesByQuery,
  releaseDateKey,
  sortEpisodes,
  summarizeEpisode,
  summarizeShow,
  truncateText,
} from '../../src/services/podcast-discovery.js';
import { saveEpisodes } from '../../src/services/podcast-library.js';
import { collectPages } from '../../src/utils/pagination.js';
import { isEpisodeUri, spotifyEpisodeUriSchema, spotifyIdSchema } from '../../src/utils/uri.js';

describe('episode URI and show ID validation', () => {
  it('accepts only episode URIs', () => {
    expect(spotifyEpisodeUriSchema.safeParse('spotify:episode:abc123').success).toBe(true);
    for (const bad of ['spotify:track:abc123', 'spotify:show:abc', 'https://open.spotify.com/episode/abc', 'spotify:episode:', 'abc']) {
      expect(spotifyEpisodeUriSchema.safeParse(bad).success, bad).toBe(false);
      expect(isEpisodeUri(bad), bad).toBe(false);
    }
  });

  it('requires a bare show ID', () => {
    expect(spotifyIdSchema.safeParse('4rOoJ6Egrf8K2IrywzwOMk').success).toBe(true);
    expect(spotifyIdSchema.safeParse('spotify:show:4rOoJ6Egrf8K2IrywzwOMk').success).toBe(false);
    expect(spotifyIdSchema.safeParse('').success).toBe(false);
  });
});

describe('metadata normalization', () => {
  it('keeps missing fields absent instead of inventing them', () => {
    const show = summarizeShow({ id: 's1', uri: 'spotify:show:s1', name: 'Show' });
    expect(show).toEqual({ id: 's1', uri: 'spotify:show:s1', name: 'Show' });
    const episode = summarizeEpisode({ id: 'e1', uri: 'spotify:episode:e1', name: 'Ep', show: null });
    expect(episode).toEqual({ id: 'e1', uri: 'spotify:episode:e1', name: 'Ep' });
  });

  it('flags unplayable episodes and truncates long descriptions', () => {
    const episode = summarizeEpisode({
      id: 'e1',
      uri: 'spotify:episode:e1',
      name: 'Ep',
      is_playable: false,
      restrictions: { reason: 'market' },
      description: 'x'.repeat(1000),
    });
    expect(episode.playable).toBe(false);
    expect(episode.restriction).toBe('market');
    expect(episode.description?.length).toBe(300);
    expect(episode.description?.endsWith('…')).toBe(true);
    expect(truncateText('   ')).toBeUndefined();
  });
});

describe('local ordering and filtering', () => {
  const episodes = [
    { name: 'b', releaseDate: '2023-05-01' },
    { name: 'none' },
    { name: 'a', releaseDate: '2024' },
    { name: 'c', releaseDate: '2021-02' },
  ];

  it('normalizes partial release dates', () => {
    expect(releaseDateKey('2024')).toBe('2024-01-01');
    expect(releaseDateKey('2021-02')).toBe('2021-02-01');
    expect(releaseDateKey('garbage')).toBeUndefined();
  });

  it('sorts newest/oldest with undated episodes last, without mutating input', () => {
    const copy = [...episodes];
    expect(sortEpisodes(episodes, EPodcastSort.Newest).map((e) => e.name)).toEqual(['a', 'b', 'c', 'none']);
    expect(sortEpisodes(episodes, EPodcastSort.Oldest).map((e) => e.name)).toEqual(['c', 'b', 'a', 'none']);
    expect(sortEpisodes(episodes, EPodcastSort.SpotifyOrder).map((e) => e.name)).toEqual(['b', 'none', 'a', 'c']);
    expect(episodes).toEqual(copy);
  });

  it('filters by title, description and show name', () => {
    const items = [
      { id: '1', uri: 'u1', name: 'Vue Tips', description: 'composition api' },
      { id: '2', uri: 'u2', name: 'Other', description: 'Software ARCHITECTURE talk' },
      { id: '3', uri: 'u3', name: 'Third', show: { id: 's', name: 'Architecture Weekly' } },
      { id: '4', uri: 'u4', name: 'Nope' },
    ];
    expect(filterEpisodesByQuery(items, 'architecture').map((i) => i.id)).toEqual(['2', '3']);
    expect(filterEpisodesByQuery(items, undefined)).toHaveLength(4);
  });
});

describe('pagination boundaries', () => {
  it('stops at maxItems and reports where to continue', async () => {
    const all = Array.from({ length: 120 }, (_, i) => i);
    const fetchPage = vi.fn(async (offset: number, limit: number) => ({
      items: all.slice(offset, offset + limit),
      total: all.length,
      next: offset + limit < all.length ? 'more' : null,
    }));
    const result = await collectPages(fetchPage, { offset: 10, pageSize: 50, maxItems: 75 });
    expect(result.items).toHaveLength(75);
    expect(result.nextOffset).toBe(85);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe('saveEpisodes service', () => {
  const makeSpotify = (saved: string[] = []) => ({
    checkLibraryContains: vi.fn(async (uris: string[]) => uris.map((uri) => saved.includes(uri))),
    saveToLibrary: vi.fn(async () => undefined),
  });

  it('rejects non-episode URIs before any request', async () => {
    const spotify = makeSpotify();
    await expect(saveEpisodes(spotify, ['spotify:track:t1'], false)).rejects.toThrow(/episode URIs/);
    expect(spotify.checkLibraryContains).not.toHaveBeenCalled();
  });

  it('detects duplicates in the input and already-saved episodes', async () => {
    const spotify = makeSpotify(['spotify:episode:a']);
    const result = await saveEpisodes(
      spotify,
      ['spotify:episode:a', 'spotify:episode:b', 'spotify:episode:b'],
      false,
    );
    expect(result.duplicateInputUris).toEqual(['spotify:episode:b']);
    expect(result.alreadySavedUris).toEqual(['spotify:episode:a']);
    expect(result.newlySavedUris).toEqual(['spotify:episode:b']);
    expect(spotify.saveToLibrary).toHaveBeenCalledWith(['spotify:episode:b']);
  });

  it('batches by 40 and reports the failing batch plus unattempted ones', async () => {
    const uris = Array.from({ length: 85 }, (_, i) => `spotify:episode:e${i}`);
    const spotify = makeSpotify();
    spotify.saveToLibrary.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));
    const result = await saveEpisodes(spotify, uris, false);
    expect(spotify.checkLibraryContains).toHaveBeenCalledTimes(3);
    expect(spotify.saveToLibrary).toHaveBeenCalledTimes(2);
    expect(result.newlySavedUris).toHaveLength(40);
    expect(result.failedUris).toHaveLength(45);
    expect(result.failedUris[0]).toEqual({ uri: 'spotify:episode:e40', reason: 'boom' });
    expect(result.failedUris[44].reason).toMatch(/Not attempted/);
  });
});
