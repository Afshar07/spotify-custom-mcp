import {
  EPlaylistItemIssue,
  EPlaylistItemKind,
  type INormalizedPlaylist,
  type INormalizedTrack,
  type IPlaylistItemIssue,
} from '../models/curation.js';
import type {
  ISpotifyPlaylistItem,
  ISpotifySimplifiedTrack,
  ISpotifyTrack,
} from '../models/spotify.js';

function releaseYearOf(releaseDate: string | undefined): number | undefined {
  const match = /^(\d{4})/.exec(releaseDate ?? '');
  return match ? Number(match[1]) : undefined;
}

/** Normalizes one Spotify track object, tolerating absent optional fields. */
export function normalizeTrack(
  track: ISpotifyTrack,
  position = 0,
  isLocal = false,
): INormalizedTrack {
  const isEpisode = track.type === 'episode' || track.uri?.startsWith('spotify:episode:');
  const kind =
    isLocal || track.is_local
      ? EPlaylistItemKind.Local
      : isEpisode
        ? EPlaylistItemKind.Episode
        : EPlaylistItemKind.Track;
  const releaseYear = releaseYearOf(track.album?.release_date);

  return {
    position,
    kind,
    uri: track.uri,
    ...(kind !== EPlaylistItemKind.Local && track.id ? { id: track.id } : {}),
    name: track.name ?? '',
    artists: Array.isArray(track.artists)
      ? track.artists.map((artist) => ({
          ...(artist.id ? { id: artist.id } : {}),
          name: artist.name,
        }))
      : [],
    ...(track.album?.id ? { albumId: track.album.id } : {}),
    ...(track.album?.name ? { albumName: track.album.name } : {}),
    ...(releaseYear !== undefined ? { releaseYear } : {}),
    ...(typeof track.duration_ms === 'number' ? { durationMs: track.duration_ms } : {}),
    ...(typeof track.explicit === 'boolean' ? { explicit: track.explicit } : {}),
    ...(track.external_urls?.spotify ? { url: track.external_urls.spotify } : {}),
  };
}

/** Normalizes an album-track object, which has no nested album. */
export function normalizeAlbumTrack(track: ISpotifySimplifiedTrack): INormalizedTrack {
  return {
    position: 0,
    kind: EPlaylistItemKind.Track,
    uri: track.uri,
    id: track.id,
    name: track.name,
    artists: (track.artists ?? []).map((artist) => ({ id: artist.id, name: artist.name })),
    ...(typeof track.duration_ms === 'number' ? { durationMs: track.duration_ms } : {}),
    ...(typeof track.explicit === 'boolean' ? { explicit: track.explicit } : {}),
  };
}

/**
 * Normalizes playlist items. Removed/unavailable items (null) are reported as
 * issues rather than dropped silently, and positions are preserved.
 */
export function normalizePlaylistItems(items: ISpotifyPlaylistItem[]): INormalizedPlaylist {
  const tracks: INormalizedTrack[] = [];
  const issues: IPlaylistItemIssue[] = [];
  const unavailablePositions: number[] = [];

  items.forEach((playlistItem, position) => {
    const raw = playlistItem.item ?? playlistItem.track ?? null;
    if (!raw || !raw.uri) {
      issues.push({ position, reason: EPlaylistItemIssue.Unavailable });
      unavailablePositions.push(position);
      return;
    }

    const track = normalizeTrack(raw, position, playlistItem.is_local === true);
    tracks.push(track);

    if (track.kind === EPlaylistItemKind.Episode) {
      issues.push({ position, reason: EPlaylistItemIssue.Episode, uri: track.uri });
      return;
    }
    if (track.kind === EPlaylistItemKind.Local) {
      issues.push({ position, reason: EPlaylistItemIssue.LocalFile, uri: track.uri });
    }
    if (track.artists.length === 0) {
      issues.push({ position, reason: EPlaylistItemIssue.MissingArtists, uri: track.uri });
    }
    if (!track.albumName) {
      issues.push({ position, reason: EPlaylistItemIssue.MissingAlbum, uri: track.uri });
    }
    if (track.releaseYear === undefined) {
      issues.push({ position, reason: EPlaylistItemIssue.MissingReleaseDate, uri: track.uri });
    }
  });

  return { tracks, issues, totalItems: items.length, unavailablePositions };
}

/** Identity used for de-duplication and set math: Spotify ID when known, else URI. */
export function trackKey(track: INormalizedTrack): string {
  return track.id ?? track.uri;
}

export function artistKey(id: string | undefined, name: string): string {
  return id ?? `name:${name.trim().toLowerCase()}`;
}

export function primaryArtistKey(track: INormalizedTrack): string | undefined {
  const artist = track.artists[0];
  return artist ? artistKey(artist.id, artist.name) : undefined;
}
