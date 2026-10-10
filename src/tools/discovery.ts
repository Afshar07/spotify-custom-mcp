import { z } from 'zod';
import type { ISpotifyAlbum } from '../models/spotify.js';
import { spotifyIdSchema } from '../utils/uri.js';
import { errorResult, jsonResult, type IToolContext } from './shared.js';

const INCLUDE_GROUPS = ['album', 'single', 'appears_on', 'compilation'] as const;
const EDITION_WORDS = /(deluxe|remaster|edition|expanded|anniversary|bonus)/i;

interface IAlbumSummary {
  id: string;
  uri: string;
  name: string;
  type?: string;
  releaseDate?: string;
  totalTracks?: number;
  artists: string[];
  url?: string;
  /** Other editions of the same release that were collapsed into this entry. */
  collapsedEditions?: number;
}

/**
 * Identity for "same release, different edition": the name with edition
 * qualifiers such as "(Deluxe Edition)" or "- 2011 Remaster" removed, plus type.
 */
export function albumEditionKey(album: ISpotifyAlbum): string {
  const base = album.name
    .replace(/[([][^)\]]*[)\]]/g, (match) => (EDITION_WORDS.test(match) ? '' : match))
    .replace(/\s[-–]\s.*$/, (match) => (EDITION_WORDS.test(match) ? '' : match))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `${base}|${album.album_type ?? ''}`;
}

export function collapseAlbumEditions(albums: ISpotifyAlbum[]): {
  albums: IAlbumSummary[];
  collapsed: number;
} {
  const byKey = new Map<string, { album: ISpotifyAlbum; extra: number }>();
  for (const album of albums) {
    const key = albumEditionKey(album);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { album, extra: 0 });
      continue;
    }
    existing.extra += 1;
    // Prefer the earliest release (the original edition).
    if ((album.release_date ?? '9999') < (existing.album.release_date ?? '9999')) {
      byKey.set(key, { album, extra: existing.extra });
    }
  }

  const summaries = [...byKey.values()].map(({ album, extra }) => summarizeAlbum(album, extra));
  return { albums: summaries, collapsed: albums.length - summaries.length };
}

function summarizeAlbum(album: ISpotifyAlbum, collapsedEditions = 0): IAlbumSummary {
  return {
    id: album.id,
    uri: album.uri,
    name: album.name,
    ...(album.album_type ? { type: album.album_type } : {}),
    ...(album.release_date ? { releaseDate: album.release_date } : {}),
    ...(album.total_tracks !== undefined ? { totalTracks: album.total_tracks } : {}),
    artists: (album.artists ?? []).map((artist) => artist.name),
    ...(album.external_urls?.spotify ? { url: album.external_urls.spotify } : {}),
    ...(collapsedEditions > 0 ? { collapsedEditions } : {}),
  };
}

export function registerDiscoveryTools({ registerTool, spotify }: IToolContext): void {
  registerTool(
    'get_artist_albums',
    {
      description:
        'List an artist\'s releases (albums, singles, etc.) for exploring their catalog. Pass an artist ID from a search or top-artists result. With dedupeEditions (default) deluxe/remaster/regional editions on the returned page are collapsed into one entry.',
      inputSchema: {
        artistId: spotifyIdSchema,
        includeGroups: z.array(z.enum(INCLUDE_GROUPS)).min(1).default(['album', 'single']),
        market: z.string().length(2).toUpperCase().optional().describe('ISO 3166-1 alpha-2 country code'),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        dedupeEditions: z.boolean().default(true),
      },
    },
    async ({ artistId, includeGroups, market, limit, offset, dedupeEditions }) => {
      try {
        const page = await spotify.getArtistAlbums(artistId, {
          includeGroups,
          market,
          limit,
          offset,
        });
        const collapsed = dedupeEditions
          ? collapseAlbumEditions(page.items)
          : { albums: page.items.map((album) => summarizeAlbum(album)), collapsed: 0 };

        return jsonResult({
          total: page.total,
          offset: page.offset,
          ...(page.next ? { nextOffset: page.offset + page.items.length } : {}),
          editionsCollapsed: collapsed.collapsed,
          items: collapsed.albums,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'get_album_tracks',
    {
      description:
        'List the tracks of an album with exact Spotify URIs, durations, and track/disc numbers.',
      inputSchema: {
        albumId: spotifyIdSchema,
        market: z.string().length(2).toUpperCase().optional().describe('ISO 3166-1 alpha-2 country code'),
        limit: z.number().int().min(1).max(50).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ albumId, market, limit, offset }) => {
      try {
        const page = await spotify.getAlbumTracks(albumId, { market, limit, offset });
        return jsonResult({
          total: page.total,
          offset: page.offset,
          ...(page.next ? { nextOffset: page.offset + page.items.length } : {}),
          items: page.items.map((track) => ({
            id: track.id,
            uri: track.uri,
            name: track.name,
            artists: (track.artists ?? []).map((artist) => artist.name),
            durationMs: track.duration_ms,
            trackNumber: track.track_number,
            discNumber: track.disc_number,
            ...(track.explicit !== undefined ? { explicit: track.explicit } : {}),
            url: track.external_urls?.spotify,
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
