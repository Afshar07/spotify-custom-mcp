import {
  EPlaylistItemIssue,
  EPlaylistItemKind,
  type IAlbumCount,
  type IArtistConcentration,
  type IArtistCount,
  type IDuplicateTrack,
  type INormalizedPlaylist,
  type INormalizedTrack,
  type IPlaylistAnalysis,
  type IPlaylistSuggestion,
} from '../models/curation.js';
import { artistKey, primaryArtistKey, trackKey } from './playlist-items.js';

export const ANALYSIS_TOP_ARTISTS = 10;
export const ANALYSIS_TOP_ALBUMS = 10;
export const ANALYSIS_MAX_DUPLICATES = 25;
/** Minimum track count before concentration-based suggestions are meaningful. */
export const SUGGESTION_MIN_TRACKS = 10;
export const SUGGESTION_TOP_ARTIST_SHARE = 0.25;
export const SUGGESTION_MIN_ARTIST_VARIETY = 0.5;

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function countIssues(playlist: INormalizedPlaylist, reason: EPlaylistItemIssue): number {
  return playlist.issues.filter((issue) => issue.reason === reason).length;
}

/**
 * Computes objective statistics from normalized playlist items. It uses only
 * metadata Spotify returns (no popularity or audio features) and reports gaps
 * instead of guessing.
 */
export function analyzePlaylist(playlist: INormalizedPlaylist): IPlaylistAnalysis {
  const items = playlist.tracks;
  const musicTracks = items.filter((track) => track.kind !== EPlaylistItemKind.Episode);

  const occurrences = new Map<string, INormalizedTrack[]>();
  for (const track of items) {
    const key = trackKey(track);
    occurrences.set(key, [...(occurrences.get(key) ?? []), track]);
  }

  const duplicates: IDuplicateTrack[] = [];
  let duplicateItemCount = 0;
  for (const group of occurrences.values()) {
    if (group.length > 1) {
      duplicateItemCount += group.length - 1;
      duplicates.push({
        uri: group[0].uri,
        name: group[0].name,
        count: group.length,
        positions: group.map((track) => track.position),
      });
    }
  }
  duplicates.sort((left, right) => right.count - left.count || left.positions[0] - right.positions[0]);

  const durations = items
    .map((track) => track.durationMs)
    .filter((duration): duration is number => typeof duration === 'number');
  const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0);

  // Artist frequency: each track counts once for every credited artist.
  const artistCounts = new Map<string, { id?: string; name: string; trackCount: number }>();
  const primaryCounts = new Map<string, number>();
  let tracksWithArtists = 0;
  for (const track of musicTracks) {
    if (track.artists.length === 0) {
      continue;
    }
    tracksWithArtists += 1;
    const seenInTrack = new Set<string>();
    for (const artist of track.artists) {
      const key = artistKey(artist.id, artist.name);
      if (seenInTrack.has(key)) {
        continue;
      }
      seenInTrack.add(key);
      const entry = artistCounts.get(key) ?? { id: artist.id, name: artist.name, trackCount: 0 };
      entry.trackCount += 1;
      artistCounts.set(key, entry);
    }
    const primary = primaryArtistKey(track);
    if (primary) {
      primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);
    }
  }

  const rankedArtists = [...artistCounts.values()].sort(
    (left, right) => right.trackCount - left.trackCount || left.name.localeCompare(right.name),
  );
  const topArtists: IArtistCount[] = rankedArtists.slice(0, ANALYSIS_TOP_ARTISTS).map((artist) => ({
    ...(artist.id ? { id: artist.id } : {}),
    name: artist.name,
    trackCount: artist.trackCount,
    share: round(artist.trackCount / tracksWithArtists),
  }));

  let concentration: IArtistConcentration | null = null;
  if (tracksWithArtists > 0) {
    const hhi = [...primaryCounts.values()].reduce(
      (sum, count) => sum + (count / tracksWithArtists) ** 2,
      0,
    );
    const topThree = rankedArtists.slice(0, 3).reduce((sum, artist) => sum + artist.trackCount, 0);
    concentration = {
      topArtistShare: round(rankedArtists[0].trackCount / tracksWithArtists),
      top3ArtistShare: round(Math.min(topThree / tracksWithArtists, 1)),
      primaryArtistHhi: round(hhi),
      effectiveArtistCount: round(1 / hhi, 2),
    };
  }

  const albumCounts = new Map<string, IAlbumCount>();
  for (const track of musicTracks) {
    if (!track.albumName) {
      continue;
    }
    const key = track.albumId ?? `name:${track.albumName.toLowerCase()}`;
    const entry = albumCounts.get(key) ?? { name: track.albumName, trackCount: 0 };
    entry.trackCount += 1;
    albumCounts.set(key, entry);
  }
  const topAlbums = [...albumCounts.values()]
    .sort((left, right) => right.trackCount - left.trackCount || left.name.localeCompare(right.name))
    .slice(0, ANALYSIS_TOP_ALBUMS);

  const yearCounts = new Map<number, number>();
  for (const track of musicTracks) {
    if (track.releaseYear !== undefined) {
      yearCounts.set(track.releaseYear, (yearCounts.get(track.releaseYear) ?? 0) + 1);
    }
  }
  const years = [...yearCounts.keys()].sort((left, right) => left - right);
  const releaseYears: Record<string, number> = {};
  for (const year of years) {
    releaseYears[String(year)] = yearCounts.get(year) ?? 0;
  }

  const explicit = { explicit: 0, clean: 0, unknown: 0 };
  for (const track of musicTracks) {
    if (track.explicit === true) {
      explicit.explicit += 1;
    } else if (track.explicit === false) {
      explicit.clean += 1;
    } else {
      explicit.unknown += 1;
    }
  }

  const missingMetadata = {
    unavailableItems: playlist.unavailablePositions.length,
    localFiles: countIssues(playlist, EPlaylistItemIssue.LocalFile),
    episodes: countIssues(playlist, EPlaylistItemIssue.Episode),
    tracksMissingArtists: countIssues(playlist, EPlaylistItemIssue.MissingArtists),
    tracksMissingAlbum: countIssues(playlist, EPlaylistItemIssue.MissingAlbum),
    tracksMissingReleaseDate: countIssues(playlist, EPlaylistItemIssue.MissingReleaseDate),
  };

  const suggestions: IPlaylistSuggestion[] = [];
  if (duplicateItemCount > 0) {
    suggestions.push({
      code: 'duplicate_tracks',
      message: `${duplicateItemCount} repeated item(s) across ${duplicates.length} track(s); consider removing the extra copies.`,
    });
  }
  if (
    concentration &&
    tracksWithArtists >= SUGGESTION_MIN_TRACKS &&
    concentration.topArtistShare > SUGGESTION_TOP_ARTIST_SHARE
  ) {
    suggestions.push({
      code: 'artist_concentration',
      message: `${rankedArtists[0].name} appears on ${round(concentration.topArtistShare * 100, 1)}% of tracks; consider adding other artists.`,
    });
  }
  if (
    tracksWithArtists >= SUGGESTION_MIN_TRACKS &&
    artistCounts.size / tracksWithArtists < SUGGESTION_MIN_ARTIST_VARIETY
  ) {
    suggestions.push({
      code: 'low_artist_variety',
      message: `${artistCounts.size} distinct artists across ${tracksWithArtists} tracks; underrepresented artists could be added for variety.`,
    });
  }
  if (missingMetadata.unavailableItems > 0) {
    suggestions.push({
      code: 'unavailable_items',
      message: `${missingMetadata.unavailableItems} item(s) are removed or unavailable and have no metadata; consider replacing them.`,
    });
  }

  return {
    totalItems: playlist.totalItems,
    uniqueTracks: occurrences.size,
    duplicateItemCount,
    duplicates: duplicates.slice(0, ANALYSIS_MAX_DUPLICATES),
    totalDurationMs,
    averageTrackDurationMs: durations.length > 0 ? Math.round(totalDurationMs / durations.length) : null,
    uniqueArtists: artistCounts.size,
    topArtists,
    concentration,
    uniqueAlbums: albumCounts.size,
    topAlbums,
    releaseYears,
    releaseYearRange: years.length > 0 ? { oldest: years[0], newest: years[years.length - 1] } : null,
    explicit,
    missingMetadata,
    suggestions,
  };
}
