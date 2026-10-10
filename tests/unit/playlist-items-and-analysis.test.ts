import { describe, expect, it } from 'vitest';
import { EPlaylistItemIssue, EPlaylistItemKind } from '../../src/models/curation.js';
import { analyzePlaylist } from '../../src/services/playlist-analysis.js';
import { normalizePlaylistItems } from '../../src/services/playlist-items.js';
import { itemFixture, trackFixture } from '../helpers/fake-spotify.js';

describe('normalizePlaylistItems', () => {
  it('reports removed/unavailable items instead of dropping them silently', () => {
    const normalized = normalizePlaylistItems([
      itemFixture(trackFixture('a1')),
      itemFixture(null),
      itemFixture(trackFixture('a2')),
    ] as never);

    expect(normalized.totalItems).toBe(3);
    expect(normalized.tracks.map((track) => track.position)).toEqual([0, 2]);
    expect(normalized.unavailablePositions).toEqual([1]);
    expect(normalized.issues).toContainEqual({ position: 1, reason: EPlaylistItemIssue.Unavailable });
  });

  it('classifies local files and episodes without requiring Spotify IDs', () => {
    const local = { ...trackFixture('l1', 'Local song'), id: null, uri: 'spotify:local:a:b:c:100', is_local: true };
    const episode = {
      id: 'ep1',
      uri: 'spotify:episode:ep1',
      name: 'Episode',
      duration_ms: 60_000,
      type: 'episode',
      explicit: false,
    };
    const normalized = normalizePlaylistItems([
      itemFixture(local, { is_local: true }),
      itemFixture(episode),
    ] as never);

    expect(normalized.tracks[0].kind).toBe(EPlaylistItemKind.Local);
    expect(normalized.tracks[0].id).toBeUndefined();
    expect(normalized.tracks[1].kind).toBe(EPlaylistItemKind.Episode);
    expect(normalized.issues.map((issue) => issue.reason)).toContain(EPlaylistItemIssue.LocalFile);
    expect(normalized.issues.map((issue) => issue.reason)).toContain(EPlaylistItemIssue.Episode);
  });

  it('tolerates missing optional fields and the legacy track field name', () => {
    const sparse = { id: 's1', uri: 'spotify:track:s1', name: 'Sparse', duration_ms: 1000, explicit: false };
    const normalized = normalizePlaylistItems([{ track: sparse }] as never);

    expect(normalized.tracks).toHaveLength(1);
    expect(normalized.tracks[0].artists).toEqual([]);
    expect(normalized.issues.map((issue) => issue.reason)).toEqual(
      expect.arrayContaining([
        EPlaylistItemIssue.MissingArtists,
        EPlaylistItemIssue.MissingAlbum,
        EPlaylistItemIssue.MissingReleaseDate,
      ]),
    );
  });

  it('derives the release year from partial dates', () => {
    const normalized = normalizePlaylistItems([
      itemFixture(trackFixture('y1', 'Y1', { releaseDate: '1999' })),
      itemFixture(trackFixture('y2', 'Y2', { releaseDate: '2003-07' })),
    ] as never);
    expect(normalized.tracks.map((track) => track.releaseYear)).toEqual([1999, 2003]);
  });
});

function analyze(items: unknown[]) {
  return analyzePlaylist(normalizePlaylistItems(items as never));
}

describe('analyzePlaylist', () => {
  it('handles an empty playlist', () => {
    const analysis = analyze([]);
    expect(analysis.totalItems).toBe(0);
    expect(analysis.uniqueTracks).toBe(0);
    expect(analysis.averageTrackDurationMs).toBeNull();
    expect(analysis.concentration).toBeNull();
    expect(analysis.releaseYearRange).toBeNull();
    expect(analysis.suggestions).toEqual([]);
  });

  it('computes totals, duplicates and durations', () => {
    const analysis = analyze([
      itemFixture(trackFixture('t1', 'One', { durationMs: 100_000 })),
      itemFixture(trackFixture('t2', 'Two', { durationMs: 200_000 })),
      itemFixture(trackFixture('t1', 'One', { durationMs: 100_000 })),
    ]);
    expect(analysis.totalItems).toBe(3);
    expect(analysis.uniqueTracks).toBe(2);
    expect(analysis.duplicateItemCount).toBe(1);
    expect(analysis.duplicates).toEqual([{ uri: 'spotify:track:t1', name: 'One', count: 2, positions: [0, 2] }]);
    expect(analysis.totalDurationMs).toBe(400_000);
    expect(analysis.averageTrackDurationMs).toBe(133_333);
    expect(analysis.suggestions.map((suggestion) => suggestion.code)).toContain('duplicate_tracks');
  });

  it('measures artist frequency and concentration', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => itemFixture(trackFixture(`m${i}`, `M${i}`, { artists: ['Main'] }))),
      ...['A', 'B', 'C', 'D'].map((artist, i) => itemFixture(trackFixture(`o${i}`, `O${i}`, { artists: [artist] }))),
    ];
    const analysis = analyze(items);

    expect(analysis.uniqueArtists).toBe(5);
    expect(analysis.topArtists[0]).toMatchObject({ name: 'Main', trackCount: 6, share: 0.6 });
    expect(analysis.concentration?.topArtistShare).toBe(0.6);
    expect(analysis.concentration?.top3ArtistShare).toBe(0.8);
    // HHI = 0.6^2 + 4 * 0.1^2 = 0.40
    expect(analysis.concentration?.primaryArtistHhi).toBe(0.4);
    expect(analysis.concentration?.effectiveArtistCount).toBe(2.5);
    expect(analysis.suggestions.map((suggestion) => suggestion.code)).toContain('artist_concentration');
  });

  it('does not emit concentration suggestions for tiny playlists', () => {
    const analysis = analyze([itemFixture(trackFixture('x1')), itemFixture(trackFixture('x2'))]);
    expect(analysis.concentration?.topArtistShare).toBe(1);
    expect(analysis.suggestions).toEqual([]);
  });

  it('counts a collaboration once per credited artist', () => {
    const analysis = analyze([itemFixture(trackFixture('c1', 'Collab', { artists: ['Lead', 'Guest'] }))]);
    expect(analysis.uniqueArtists).toBe(2);
    expect(analysis.topArtists.map((artist) => artist.trackCount)).toEqual([1, 1]);
  });

  it('summarizes albums, release years and explicit flags', () => {
    const analysis = analyze([
      itemFixture(trackFixture('a1', 'A1', { album: 'Shared', albumId: 'alS', releaseDate: '2001-01-01', explicit: true })),
      itemFixture(trackFixture('a2', 'A2', { album: 'Shared', albumId: 'alS', releaseDate: '2001-01-01' })),
      itemFixture(trackFixture('a3', 'A3', { releaseDate: '2010-06-01' })),
    ]);
    expect(analysis.uniqueAlbums).toBe(2);
    expect(analysis.topAlbums[0]).toEqual({ name: 'Shared', trackCount: 2 });
    expect(analysis.releaseYears).toEqual({ '2001': 2, '2010': 1 });
    expect(analysis.releaseYearRange).toEqual({ oldest: 2001, newest: 2010 });
    expect(analysis.explicit).toEqual({ explicit: 1, clean: 2, unknown: 0 });
  });

  it('reports unavailable items and missing metadata rather than guessing', () => {
    const sparse = { id: 's1', uri: 'spotify:track:s1', name: 'Sparse', duration_ms: 1000 };
    const analysis = analyze([itemFixture(null), itemFixture(sparse), itemFixture(trackFixture('ok'))]);

    expect(analysis.totalItems).toBe(3);
    expect(analysis.missingMetadata).toMatchObject({
      unavailableItems: 1,
      tracksMissingArtists: 1,
      tracksMissingAlbum: 1,
      tracksMissingReleaseDate: 1,
    });
    expect(analysis.explicit.unknown).toBe(1);
    expect(analysis.suggestions.map((suggestion) => suggestion.code)).toContain('unavailable_items');
  });

  it('leaves episodes out of artist and album statistics but counts them', () => {
    const episode = { id: 'ep1', uri: 'spotify:episode:ep1', name: 'Ep', duration_ms: 60_000, type: 'episode' };
    const analysis = analyze([itemFixture(episode), itemFixture(trackFixture('t1'))]);
    expect(analysis.totalItems).toBe(2);
    expect(analysis.uniqueArtists).toBe(1);
    expect(analysis.missingMetadata.episodes).toBe(1);
    expect(analysis.totalDurationMs).toBe(240_000);
  });
});
