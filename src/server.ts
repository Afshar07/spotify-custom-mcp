import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getSpotifyConfig } from './config.js';
import { SpotifyClient, type ISpotifyTrack } from './spotify.js';

interface ITrackSummary {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  explicit: boolean;
  url?: string;
}

interface IPlaylistSummary {
  playlistId: string;
  totalItemCount: number;
  snapshotId?: string;
  tracks: IPlaylistTrackSummary[];
}

interface IPlaylistTrackSummary {
  uri: string;
  name: string;
  artists: string[];
}

interface IPlaylistMutationPreview {
  dryRun: true;
  playlistId: string;
  currentSnapshotId?: string;
  operation: string;
  requestedUris?: string[];
  rangeStart?: number;
  insertBefore?: number;
  rangeLength?: number;
}

const spotifyPlaylistItemUriSchema = z
  .string()
  .regex(
    /^spotify:(?:track|episode):[A-Za-z0-9]+$/,
    'Expected a Spotify track or episode URI.',
  );

const spotifyTrackUriSchema = z
  .string()
  .regex(/^spotify:track:[A-Za-z0-9]+$/, 'Expected a Spotify track URI.');

const spotify = new SpotifyClient(getSpotifyConfig());
const server = new McpServer({
  name: 'spotify-custom-mcp',
  version: '0.1.0',
});

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function summarizeTrack(track: ISpotifyTrack): ITrackSummary {
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((artist) => artist.name),
    album: track.album.name,
    durationMs: track.duration_ms,
    explicit: track.explicit,
    url: track.external_urls?.spotify,
  };
}

function summarizePlaylistTrack(track: ISpotifyTrack): IPlaylistTrackSummary {
  return {
    uri: track.uri,
    name: track.name,
    artists: Array.isArray(track.artists) ? track.artists.map((artist) => artist.name) : [],
  };
}

async function getPlaylistSummary(playlistId: string): Promise<IPlaylistSummary> {
  const snapshotId = await spotify.getPlaylistSnapshot(playlistId);
  const page = await spotify.getPlaylistItems(playlistId, { all: true });

  return {
    playlistId,
    totalItemCount: page.total,
    ...(snapshotId ? { snapshotId } : {}),
    tracks: page.items
      .map((playlistItem) => playlistItem.item)
      .filter((track): track is ISpotifyTrack => Boolean(track))
      .map(summarizePlaylistTrack),
  };
}

async function getCurrentSnapshotId(
  playlistId: string,
  expectedSnapshotId: string | undefined,
  mustRead: boolean,
): Promise<string | undefined> {
  if (!expectedSnapshotId && !mustRead) {
    return undefined;
  }

  const currentSnapshotId = await spotify.getPlaylistSnapshot(playlistId);
  if (expectedSnapshotId && currentSnapshotId !== expectedSnapshotId) {
    throw new Error(
      `Playlist snapshot mismatch. Expected ${expectedSnapshotId}, but current snapshot is ${currentSnapshotId ?? 'unavailable'}. No changes were made.`,
    );
  }
  return currentSnapshotId;
}

server.registerTool(
  'search_tracks',
  {
    description: 'Search Spotify tracks and return exact Spotify URIs for playlist operations.',
    inputSchema: {
      query: z.string().min(1).describe('Spotify search query, e.g. "artist:Sleep Token Granite"'),
      limit: z.number().int().min(1).max(10).default(5),
    },
  },
  async ({ query, limit }) => {
    try {
      const tracks = await spotify.searchTracks(query, limit);
      return jsonResult(tracks.map(summarizeTrack));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'get_playlist_summary',
  {
    description:
      'Read a compact playlist summary with its current snapshot ID and track URIs, names, and artists for planning and deduplication.',
    inputSchema: {
      playlistId: z.string().min(1).describe('Spotify playlist ID, not the full URL'),
    },
  },
  async ({ playlistId }) => {
    try {
      return jsonResult(await getPlaylistSummary(playlistId));
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'get_playlist_items',
  {
    description:
      'Read playlist items. Use all=true before adding recommendations so you can detect duplicates.',
    inputSchema: {
      playlistId: z.string().min(1).describe('Spotify playlist ID, not the full URL'),
      limit: z.number().int().min(1).max(100).default(100),
      offset: z.number().int().min(0).default(0),
      all: z.boolean().default(false),
    },
  },
  async ({ playlistId, limit, offset, all }) => {
    try {
      const page = await spotify.getPlaylistItems(playlistId, {
        limit,
        offset,
        all,
      });

      return jsonResult({
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        next: page.next,
        items: page.items
          .map((playlistItem) => playlistItem.item)
          .filter((track): track is ISpotifyTrack => Boolean(track))
          .map(summarizeTrack),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'add_playlist_items',
  {
    description:
      'Add up to 100 Spotify track/episode URIs to an existing playlist. Read the playlist first when duplicate prevention matters.',
    inputSchema: {
      playlistId: z.string().min(1),
      uris: z.array(spotifyPlaylistItemUriSchema).min(1).max(100),
      position: z.number().int().min(0).optional(),
      expectedSnapshotId: z.string().min(1).optional(),
      dryRun: z.boolean().default(false),
    },
  },
  async ({ playlistId, uris, position, expectedSnapshotId, dryRun }) => {
    try {
      const currentSnapshotId = await getCurrentSnapshotId(
        playlistId,
        expectedSnapshotId,
        dryRun,
      );
      if (dryRun) {
        const preview: IPlaylistMutationPreview = {
          dryRun: true,
          playlistId,
          operation: 'add_playlist_items',
          requestedUris: uris,
          ...(currentSnapshotId ? { currentSnapshotId } : {}),
        };
        return jsonResult(preview);
      }
      const result = await spotify.addPlaylistItems({
        playlistId,
        uris,
        position,
      });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'add_unique_playlist_items',
  {
    description:
      'Preferred playlist-addition tool. Reads the current playlist, rejects stale expected snapshots, and adds only requested URIs not already present or duplicated in the request.',
    inputSchema: {
      playlistId: z.string().min(1),
      uris: z.array(spotifyPlaylistItemUriSchema).min(1).max(100),
      position: z.number().int().min(0).optional(),
      expectedSnapshotId: z.string().min(1).optional(),
      dryRun: z.boolean().default(false),
    },
  },
  async ({ playlistId, uris, position, expectedSnapshotId, dryRun }) => {
    try {
      const playlist = await getPlaylistSummary(playlistId);
      if (expectedSnapshotId && playlist.snapshotId !== expectedSnapshotId) {
        throw new Error(
          `Playlist snapshot mismatch. Expected ${expectedSnapshotId}, but current snapshot is ${playlist.snapshotId ?? 'unavailable'}. No changes were made.`,
        );
      }

      const existingUris = new Set(playlist.tracks.map((track) => track.uri));
      const requestedUris = new Set<string>();
      const addedUris: string[] = [];
      const skippedDuplicateUris: string[] = [];

      for (const uri of uris) {
        if (existingUris.has(uri) || requestedUris.has(uri)) {
          skippedDuplicateUris.push(uri);
        } else {
          requestedUris.add(uri);
          addedUris.push(uri);
        }
      }

      if (dryRun || addedUris.length === 0) {
        return jsonResult({
          dryRun,
          requestedUris: uris,
          addedUris,
          skippedDuplicateUris,
          ...(playlist.snapshotId ? { resultingSnapshotId: playlist.snapshotId } : {}),
        });
      }

      const result = await spotify.addPlaylistItems({ playlistId, uris: addedUris, position });
      return jsonResult({
        requestedUris: uris,
        addedUris,
        skippedDuplicateUris,
        resultingSnapshotId: result.snapshot_id,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'remove_playlist_items',
  {
    description: 'Remove up to 100 Spotify URIs from an existing playlist.',
    inputSchema: {
      playlistId: z.string().min(1),
      uris: z.array(spotifyPlaylistItemUriSchema).min(1).max(100),
      snapshotId: z.string().min(1).optional(),
      expectedSnapshotId: z.string().min(1).optional(),
      dryRun: z.boolean().default(false),
    },
  },
  async ({ playlistId, uris, snapshotId, expectedSnapshotId, dryRun }) => {
    try {
      if (snapshotId && expectedSnapshotId && snapshotId !== expectedSnapshotId) {
        throw new Error('snapshotId and expectedSnapshotId must match when both are provided.');
      }
      const currentSnapshotId = await getCurrentSnapshotId(
        playlistId,
        expectedSnapshotId,
        dryRun,
      );
      if (dryRun) {
        return jsonResult({
          dryRun: true,
          playlistId,
          operation: 'remove_playlist_items',
          requestedUris: uris,
          ...(currentSnapshotId ? { currentSnapshotId } : {}),
        } satisfies IPlaylistMutationPreview);
      }
      const result = await spotify.removePlaylistItems({
        playlistId,
        uris,
        snapshotId: expectedSnapshotId ?? snapshotId,
      });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'reorder_playlist_items',
  {
    description: 'Move one item or a contiguous range to another playlist position.',
    inputSchema: {
      playlistId: z.string().min(1),
      rangeStart: z.number().int().min(0),
      insertBefore: z.number().int().min(0),
      rangeLength: z.number().int().min(1).optional(),
      snapshotId: z.string().min(1).optional(),
      expectedSnapshotId: z.string().min(1).optional(),
      dryRun: z.boolean().default(false),
    },
  },
  async ({
    playlistId,
    rangeStart,
    insertBefore,
    rangeLength,
    snapshotId,
    expectedSnapshotId,
    dryRun,
  }) => {
    try {
      if (snapshotId && expectedSnapshotId && snapshotId !== expectedSnapshotId) {
        throw new Error('snapshotId and expectedSnapshotId must match when both are provided.');
      }
      const currentSnapshotId = await getCurrentSnapshotId(
        playlistId,
        expectedSnapshotId,
        dryRun,
      );
      if (dryRun) {
        return jsonResult({
          dryRun: true,
          playlistId,
          operation: 'reorder_playlist_items',
          rangeStart,
          insertBefore,
          ...(rangeLength !== undefined ? { rangeLength } : {}),
          ...(currentSnapshotId ? { currentSnapshotId } : {}),
        } satisfies IPlaylistMutationPreview);
      }
      const result = await spotify.reorderPlaylistItems({
        playlistId,
        rangeStart,
        insertBefore,
        rangeLength,
        snapshotId: expectedSnapshotId ?? snapshotId,
      });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'replace_playlist_items',
  {
    description:
      'Replace all playlist items with up to 100 Spotify URIs. Destructive: existing items not supplied are removed.',
    inputSchema: {
      playlistId: z.string().min(1),
      uris: z.array(spotifyPlaylistItemUriSchema).max(100),
      expectedSnapshotId: z.string().min(1).optional(),
      dryRun: z.boolean().default(false),
    },
  },
  async ({ playlistId, uris, expectedSnapshotId, dryRun }) => {
    try {
      const currentSnapshotId = await getCurrentSnapshotId(
        playlistId,
        expectedSnapshotId,
        dryRun,
      );
      if (dryRun) {
        return jsonResult({
          dryRun: true,
          playlistId,
          operation: 'replace_playlist_items',
          requestedUris: uris,
          ...(currentSnapshotId ? { currentSnapshotId } : {}),
        } satisfies IPlaylistMutationPreview);
      }
      const result = await spotify.replacePlaylistItems({ playlistId, uris });
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  'add_liked_tracks',
  {
    description:
      'Check up to 40 Spotify track URIs against the current user\'s Liked Songs and save only those not already present.',
    inputSchema: {
      uris: z.array(spotifyTrackUriSchema).min(1).max(40),
      dryRun: z.boolean().default(false),
    },
  },
  async ({ uris, dryRun }) => {
    try {
      return jsonResult(await spotify.addLikedTracksIfMissing(uris, dryRun));
    } catch (error) {
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
