import type { IPlaylistListEntry } from '../models/playlist.js';
import type { SpotifyClient } from '../spotify.js';
import { PLAYLIST_SCAN_LIMIT, summarizePlaylist } from './playlist-creation.js';

export interface IListPlaylistsOptions {
  limit: number;
  offset: number;
  nameFilter?: string;
  ownedOnly: boolean;
}

export interface IListPlaylistsResult {
  total?: number;
  scanned: number;
  nextOffset?: number;
  playlists: IPlaylistListEntry[];
}

/**
 * Lists the current user's playlists. Without filters this is a single Spotify
 * page. With filters, pages are scanned (bounded) until `limit` matches are
 * found, and `nextOffset` tells the caller where to continue.
 */
export async function listMyPlaylists(
  spotify: SpotifyClient,
  options: IListPlaylistsOptions,
): Promise<IListPlaylistsResult> {
  const filtering = Boolean(options.nameFilter) || options.ownedOnly;
  const me = filtering || options.ownedOnly ? await spotify.getCurrentUser() : undefined;

  if (!filtering) {
    const page = await spotify.getMyPlaylists({ limit: options.limit, offset: options.offset });
    return {
      total: page.total,
      scanned: page.items.length,
      ...(page.next && page.items.length > 0 ? { nextOffset: options.offset + page.items.length } : {}),
      playlists: page.items.map((playlist) => summarizePlaylist(playlist)),
    };
  }

  const wanted = options.nameFilter?.trim().toLowerCase();
  const playlists: IPlaylistListEntry[] = [];
  let offset = options.offset;
  let scanned = 0;
  let total: number | undefined;
  let nextOffset: number | undefined;

  while (playlists.length < options.limit && scanned < PLAYLIST_SCAN_LIMIT) {
    const page = await spotify.getMyPlaylists({ limit: 50, offset });
    total = page.total;

    for (const [index, playlist] of page.items.entries()) {
      scanned += 1;
      const matchesName = !wanted || playlist.name.toLowerCase().includes(wanted);
      const matchesOwner = !options.ownedOnly || playlist.owner?.id === me?.id;
      if (matchesName && matchesOwner) {
        playlists.push(summarizePlaylist(playlist, me?.id));
        if (playlists.length >= options.limit) {
          if (index + 1 < page.items.length || page.next) {
            nextOffset = offset + index + 1;
          }
          return { total, scanned, ...(nextOffset !== undefined ? { nextOffset } : {}), playlists };
        }
      }
    }

    offset += page.items.length;
    if (!page.next || page.items.length === 0) {
      return { total, scanned, playlists };
    }
    nextOffset = offset;
  }

  return { total, scanned, ...(nextOffset !== undefined ? { nextOffset } : {}), playlists };
}
