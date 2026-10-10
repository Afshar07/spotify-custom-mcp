import type {
  ICreatePlaylistInput,
  ICreatePlaylistResult,
  IPlaylistListEntry,
  IPlaylistPopulation,
} from '../models/playlist.js';
import type { ISpotifyPlaylist } from '../models/spotify.js';
import type { SpotifyClient } from '../spotify.js';
import { chunk, dedupePreservingOrder } from '../utils/uri.js';
import { collectPages } from '../utils/pagination.js';

export const PLAYLIST_NAME_MAX_LENGTH = 100;
export const PLAYLIST_DESCRIPTION_MAX_LENGTH = 300;
/** Upper bound on playlists scanned for ownership/name checks. */
export const PLAYLIST_SCAN_LIMIT = 500;

export function summarizePlaylist(
  playlist: ISpotifyPlaylist,
  currentUserId?: string,
): IPlaylistListEntry {
  const itemCount = playlist.items?.total ?? playlist.tracks?.total;
  return {
    id: playlist.id,
    name: playlist.name,
    ...(playlist.description ? { description: playlist.description } : {}),
    owner: playlist.owner?.display_name ?? playlist.owner?.id ?? 'unknown',
    ...(playlist.owner?.id ? { ownerId: playlist.owner.id } : {}),
    ...(currentUserId && playlist.owner?.id ? { isOwner: playlist.owner.id === currentUserId } : {}),
    ...(playlist.public !== undefined ? { public: playlist.public } : {}),
    ...(playlist.collaborative ? { collaborative: true } : {}),
    ...(itemCount !== undefined ? { itemCount } : {}),
    ...(playlist.external_urls?.spotify ? { url: playlist.external_urls.spotify } : {}),
  };
}

/** Finds playlists owned by the current user whose name matches exactly (case-insensitive). */
export async function findOwnedPlaylistsByName(
  spotify: SpotifyClient,
  name: string,
): Promise<IPlaylistListEntry[]> {
  const me = await spotify.getCurrentUser();
  const wanted = name.trim().toLowerCase();
  const collected = await collectPages(
    (offset, limit) => spotify.getMyPlaylists({ offset, limit }),
    { offset: 0, pageSize: 50, maxItems: PLAYLIST_SCAN_LIMIT },
  );
  return collected.items
    .filter((playlist) => playlist.owner?.id === me.id && playlist.name.trim().toLowerCase() === wanted)
    .map((playlist) => summarizePlaylist(playlist, me.id));
}

export function validatePlaylistDetails(name: string | undefined, description: string | undefined): void {
  if (name !== undefined) {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > PLAYLIST_NAME_MAX_LENGTH) {
      throw new Error(`Playlist name must be 1–${PLAYLIST_NAME_MAX_LENGTH} characters.`);
    }
  }
  if (description !== undefined && description.length > PLAYLIST_DESCRIPTION_MAX_LENGTH) {
    throw new Error(`Playlist description must be at most ${PLAYLIST_DESCRIPTION_MAX_LENGTH} characters.`);
  }
}

/**
 * Creates a playlist and optionally fills it. A dry run only reads (to warn
 * about same-name playlists) and never calls a mutation endpoint. Creation is
 * attempted once and never retried; if populating fails, the created playlist
 * is reported rather than hidden.
 */
export async function createPlaylistWithTracks(
  spotify: SpotifyClient,
  input: ICreatePlaylistInput,
  dryRun: boolean,
): Promise<ICreatePlaylistResult> {
  const name = input.name.trim();
  validatePlaylistDetails(name, input.description);

  const { unique, duplicates } = dedupePreservingOrder(input.trackUris);
  const population: IPlaylistPopulation = {
    requestedUris: input.trackUris,
    addedUris: [],
    skippedDuplicateUris: duplicates,
  };
  const warnings: string[] = [];

  let existing: IPlaylistListEntry[] = [];
  try {
    existing = await findOwnedPlaylistsByName(spotify, name);
  } catch (error) {
    warnings.push(
      `Could not check for existing playlists with this name: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (existing.length > 0) {
    if (!dryRun && !input.allowDuplicateName) {
      throw new Error(
        `You already own ${existing.length} playlist(s) named "${name}" (first ID: ${existing[0].id}). Nothing was created. Use that playlist, pick another name, or pass allowDuplicateName: true.`,
      );
    }
    warnings.push(`You already own ${existing.length} playlist(s) named "${name}".`);
  }

  if (dryRun) {
    return {
      dryRun: true,
      created: false,
      preview: {
        name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        public: input.public,
      },
      population: { ...population, addedUris: unique },
      ...(existing.length > 0 ? { existingSameNamePlaylists: existing } : {}),
      warnings,
    };
  }

  const playlist = await spotify.createPlaylist({
    name,
    description: input.description,
    public: input.public,
  });

  const result: ICreatePlaylistResult = {
    dryRun: false,
    created: true,
    playlist: {
      id: playlist.id,
      name: playlist.name,
      public: playlist.public ?? null,
      ...(playlist.external_urls?.spotify ? { url: playlist.external_urls.spotify } : {}),
      ...(playlist.snapshot_id ? { snapshotId: playlist.snapshot_id } : {}),
    },
    population,
    warnings,
  };

  for (const batch of chunk(unique, 100)) {
    try {
      const added = await spotify.addPlaylistItems({ playlistId: playlist.id, uris: batch });
      population.addedUris.push(...batch);
      if (result.playlist) {
        result.playlist.snapshotId = added.snapshot_id;
      }
    } catch (error) {
      const failedUris = unique.filter((uri) => !population.addedUris.includes(uri));
      population.failed = {
        uris: failedUris,
        error: error instanceof Error ? error.message : String(error),
      };
      warnings.push(
        `The playlist was created, but adding tracks failed. ${population.addedUris.length} added, ${failedUris.length} not added. The playlist was not removed; read it before retrying with add_unique_playlist_items.`,
      );
      break;
    }
  }

  return result;
}
