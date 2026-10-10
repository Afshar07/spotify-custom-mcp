import { z } from 'zod';
import {
  PLAYLIST_DESCRIPTION_MAX_LENGTH,
  PLAYLIST_NAME_MAX_LENGTH,
  createPlaylistWithTracks,
  validatePlaylistDetails,
} from '../services/playlist-creation.js';
import { listMyPlaylists } from '../services/playlist-listing.js';
import { spotifyIdSchema, spotifyTrackUriSchema } from '../utils/uri.js';
import { errorResult, jsonErrorResult, jsonResult, type IToolContext } from './shared.js';

interface IFieldChange {
  from: string | boolean | null | undefined;
  to: string | boolean;
}

export function registerPlaylistTools({ registerTool, spotify }: IToolContext): void {
  registerTool(
    'list_my_playlists',
    {
      description:
        'List playlists owned or followed by the authenticated user, compactly. Without filters returns one Spotify page; with nameFilter/ownedOnly it scans (bounded) and returns nextOffset to continue. Requires the playlist-read-private scope.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        nameFilter: z.string().min(1).optional().describe('Case-insensitive substring of the playlist name'),
        ownedOnly: z.boolean().default(false).describe('Only playlists owned by the current user'),
      },
    },
    async ({ limit, offset, nameFilter, ownedOnly }) => {
      try {
        return jsonResult(await listMyPlaylists(spotify, { limit, offset, nameFilter, ownedOnly }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'create_playlist',
    {
      description:
        'Create a playlist on the authenticated user\'s account, optionally filled with up to 100 exact track URIs (duplicates in the request are skipped). dryRun previews without creating. Refuses to create when you already own a playlist with the same name unless allowDuplicateName is true. If adding tracks fails after creation, the result reports the created playlist and the tracks that were not added.',
      inputSchema: {
        name: z.string().trim().min(1).max(PLAYLIST_NAME_MAX_LENGTH),
        description: z.string().max(PLAYLIST_DESCRIPTION_MAX_LENGTH).optional(),
        public: z.boolean().default(false),
        trackUris: z.array(spotifyTrackUriSchema).max(100).default([]),
        allowDuplicateName: z.boolean().default(false),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ name, description, public: isPublic, trackUris, allowDuplicateName, dryRun }) => {
      try {
        const result = await createPlaylistWithTracks(
          spotify,
          { name, description, public: isPublic, trackUris, allowDuplicateName },
          dryRun,
        );
        return result.population.failed ? jsonErrorResult(result) : jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'update_playlist_details',
    {
      description:
        'Update the name, description, or visibility of a playlist you own. At least one field is required. dryRun previews the field changes without sending an update.',
      inputSchema: {
        playlistId: spotifyIdSchema,
        name: z.string().trim().min(1).max(PLAYLIST_NAME_MAX_LENGTH).optional(),
        description: z.string().max(PLAYLIST_DESCRIPTION_MAX_LENGTH).optional(),
        public: z.boolean().optional(),
        dryRun: z.boolean().default(false),
      },
    },
    async ({ playlistId, name, description, public: isPublic, dryRun }) => {
      try {
        if (name === undefined && description === undefined && isPublic === undefined) {
          throw new Error('Provide at least one of name, description, or public.');
        }
        validatePlaylistDetails(name, description);

        const [playlist, me] = await Promise.all([
          spotify.getPlaylist(playlistId),
          spotify.getCurrentUser(),
        ]);
        if (playlist.owner?.id && playlist.owner.id !== me.id) {
          throw new Error(
            `You do not own this playlist (owner: ${playlist.owner.display_name ?? playlist.owner.id}); only the owner can change its details. No changes were made.`,
          );
        }

        const changes: Record<string, IFieldChange> = {};
        if (name !== undefined && name !== playlist.name) {
          changes.name = { from: playlist.name, to: name };
        }
        if (description !== undefined && description !== (playlist.description ?? '')) {
          changes.description = { from: playlist.description, to: description };
        }
        if (isPublic !== undefined && isPublic !== playlist.public) {
          changes.public = { from: playlist.public, to: isPublic };
        }

        if (Object.keys(changes).length === 0) {
          return jsonResult({ playlistId, updated: false, dryRun, message: 'Playlist already matches; nothing to update.' });
        }
        if (dryRun) {
          return jsonResult({ playlistId, dryRun: true, updated: false, changes });
        }

        await spotify.updatePlaylistDetails({
          playlistId,
          ...(changes.name ? { name } : {}),
          ...(changes.description ? { description } : {}),
          ...(changes.public ? { public: isPublic } : {}),
        });
        return jsonResult({ playlistId, dryRun: false, updated: true, changes });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
