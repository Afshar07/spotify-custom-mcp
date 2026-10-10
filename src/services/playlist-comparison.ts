import {
  EPlaylistItemKind,
  type IArtistOverlap,
  type ICompareOptions,
  type INormalizedPlaylist,
  type INormalizedTrack,
  type IPlaylistComparison,
  type IPlaylistSide,
  type ITrackRef,
  type ITruncatedList,
} from '../models/curation.js';
import { artistKey } from './playlist-items.js';

interface ISideIndex {
  /** First occurrence of each unique track, keyed by Spotify track ID. */
  uniqueTracks: Map<string, INormalizedTrack>;
  duplicateItems: number;
  nonTrackItems: number;
  totalDurationMs: number;
  /** Artist key -> { name, number of unique tracks featuring the artist }. */
  artists: Map<string, { name: string; tracks: number }>;
}

function indexSide(playlist: INormalizedPlaylist): ISideIndex {
  const uniqueTracks = new Map<string, INormalizedTrack>();
  let duplicateItems = 0;
  let nonTrackItems = 0;
  let totalDurationMs = 0;

  for (const track of playlist.tracks) {
    totalDurationMs += track.durationMs ?? 0;
    if (track.kind !== EPlaylistItemKind.Track || !track.id) {
      nonTrackItems += 1;
      continue;
    }
    if (uniqueTracks.has(track.id)) {
      duplicateItems += 1;
    } else {
      uniqueTracks.set(track.id, track);
    }
  }
  nonTrackItems += playlist.unavailablePositions.length;

  const artists = new Map<string, { name: string; tracks: number }>();
  for (const track of uniqueTracks.values()) {
    const seen = new Set<string>();
    for (const artist of track.artists) {
      const key = artistKey(artist.id, artist.name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const entry = artists.get(key) ?? { name: artist.name, tracks: 0 };
      entry.tracks += 1;
      artists.set(key, entry);
    }
  }

  return { uniqueTracks, duplicateItems, nonTrackItems, totalDurationMs, artists };
}

function toRef(track: INormalizedTrack): ITrackRef {
  return { uri: track.uri, name: track.name, artists: track.artists.map((artist) => artist.name) };
}

function truncated(tracks: INormalizedTrack[], max: number): ITruncatedList<ITrackRef> {
  return {
    count: tracks.length,
    items: tracks.slice(0, max).map(toRef),
    truncated: tracks.length > max,
  };
}

function describeSide(playlist: INormalizedPlaylist, index: ISideIndex): IPlaylistSide {
  return {
    items: playlist.totalItems,
    uniqueTracks: index.uniqueTracks.size,
    duplicateItems: index.duplicateItems,
    nonTrackItems: index.nonTrackItems,
    totalDurationMs: index.totalDurationMs,
  };
}

/**
 * Jaccard similarity of two sets: |A ∩ B| / |A ∪ B|. Defined as 0 when both
 * sets are empty (the union is empty, so the ratio is undefined).
 */
export function jaccardSimilarity(intersectionSize: number, unionSize: number): number {
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Compares two playlists by unique Spotify track IDs. Local files, episodes and
 * unavailable items have no comparable track ID, so they are counted separately.
 */
export function comparePlaylists(
  playlistA: INormalizedPlaylist,
  playlistB: INormalizedPlaylist,
  options: ICompareOptions,
): IPlaylistComparison {
  const a = indexSide(playlistA);
  const b = indexSide(playlistB);

  const shared: INormalizedTrack[] = [];
  const onlyInA: INormalizedTrack[] = [];
  for (const [id, track] of a.uniqueTracks) {
    (b.uniqueTracks.has(id) ? shared : onlyInA).push(track);
  }
  const onlyInB = [...b.uniqueTracks.entries()]
    .filter(([id]) => !a.uniqueTracks.has(id))
    .map(([, track]) => track);

  const intersectionSize = shared.length;
  const unionSize = a.uniqueTracks.size + b.uniqueTracks.size - intersectionSize;

  const sharedArtistKeys = [...a.artists.keys()].filter((key) => b.artists.has(key));
  const artistUnion = a.artists.size + b.artists.size - sharedArtistKeys.length;
  const artistOverlap: IArtistOverlap = {
    sharedArtists: sharedArtistKeys.length,
    uniqueArtistsA: a.artists.size,
    uniqueArtistsB: b.artists.size,
    artistJaccard: round(jaccardSimilarity(sharedArtistKeys.length, artistUnion)),
    top: sharedArtistKeys
      .map((key) => ({
        name: a.artists.get(key)?.name ?? '',
        tracksInA: a.artists.get(key)?.tracks ?? 0,
        tracksInB: b.artists.get(key)?.tracks ?? 0,
      }))
      .sort(
        (left, right) =>
          right.tracksInA + right.tracksInB - (left.tracksInA + left.tracksInB) ||
          left.name.localeCompare(right.name),
      )
      .slice(0, options.maxListItems),
  };

  const notes: string[] = [];
  if (a.uniqueTracks.size === 0 && b.uniqueTracks.size === 0) {
    notes.push('Both playlists have no comparable tracks; similarity is defined as 0.');
  } else if (a.uniqueTracks.size === 0) {
    notes.push('Playlist A has no comparable tracks.');
  } else if (b.uniqueTracks.size === 0) {
    notes.push('Playlist B has no comparable tracks.');
  }
  if (a.nonTrackItems + b.nonTrackItems > 0) {
    notes.push(
      'Local files, episodes and unavailable items have no Spotify track ID and are excluded from the similarity calculation.',
    );
  }

  return {
    a: describeSide(playlistA, a),
    b: describeSide(playlistB, b),
    intersectionSize,
    unionSize,
    similarity: round(jaccardSimilarity(intersectionSize, unionSize)),
    shared: truncated(shared, options.maxListItems),
    onlyInA: truncated(onlyInA, options.maxListItems),
    onlyInB: truncated(onlyInB, options.maxListItems),
    artistOverlap,
    ...(options.includeMergeCandidates
      ? {
          mergeCandidates: {
            intoA: truncated(onlyInB, options.maxListItems),
            intoB: truncated(onlyInA, options.maxListItems),
          },
        }
      : {}),
    notes,
  };
}
