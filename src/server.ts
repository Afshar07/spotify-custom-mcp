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

const spotify = new SpotifyClient(getSpotifyConfig());
const server = new McpServer({
  name: 'spotify-playlist-mcp',
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
      uris: z.array(z.string().min(1)).min(1).max(100),
      position: z.number().int().min(0).optional(),
    },
  },
  async ({ playlistId, uris, position }) => {
    try {
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
  'remove_playlist_items',
  {
    description: 'Remove up to 100 Spotify URIs from an existing playlist.',
    inputSchema: {
      playlistId: z.string().min(1),
      uris: z.array(z.string().min(1)).min(1).max(100),
      snapshotId: z.string().min(1).optional(),
    },
  },
  async ({ playlistId, uris, snapshotId }) => {
    try {
      const result = await spotify.removePlaylistItems({
        playlistId,
        uris,
        snapshotId,
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
    },
  },
  async ({ playlistId, rangeStart, insertBefore, rangeLength, snapshotId }) => {
    try {
      const result = await spotify.reorderPlaylistItems({
        playlistId,
        rangeStart,
        insertBefore,
        rangeLength,
        snapshotId,
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
      uris: z.array(z.string().min(1)).max(100),
    },
  },
  async ({ playlistId, uris }) => {
    try {
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
      uris: z.array(z.string().regex(/^spotify:track:/)).min(1).max(40),
    },
  },
  async ({ uris }) => {
    try {
      return jsonResult(await spotify.addLikedTracksIfMissing(uris));
    } catch (error) {
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
