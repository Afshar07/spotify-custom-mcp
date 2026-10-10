import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  ISpotifyArtist,
  ISpotifyTrack,
} from '../models/spotify.js';
import type { SpotifyClient } from '../spotify.js';

export interface IToolContext {
  registerTool: McpServer['registerTool'];
  spotify: SpotifyClient;
}

export interface ITrackSummary {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  explicit: boolean;
  url?: string;
}

export interface IArtistSummary {
  id: string;
  uri: string;
  name: string;
  genres?: string[];
  url?: string;
}

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

/** A structured result that clients should still treat as a failure. */
export function jsonErrorResult(value: unknown): CallToolResult {
  return { ...jsonResult(value), isError: true };
}

export function errorResult(error: unknown): CallToolResult {
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

export function summarizeTrack(track: ISpotifyTrack): ITrackSummary {
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists ?? []).map((artist) => artist.name),
    album: track.album?.name ?? '',
    durationMs: track.duration_ms,
    explicit: track.explicit,
    url: track.external_urls?.spotify,
  };
}

export function summarizeArtist(artist: ISpotifyArtist): IArtistSummary {
  return {
    id: artist.id,
    uri: artist.uri,
    name: artist.name,
    ...(artist.genres?.length ? { genres: artist.genres } : {}),
    ...(artist.external_urls?.spotify ? { url: artist.external_urls.spotify } : {}),
  };
}

export function assertSnapshotMatches(
  expectedSnapshotId: string | undefined,
  currentSnapshotId: string | undefined,
): void {
  if (expectedSnapshotId && currentSnapshotId !== expectedSnapshotId) {
    throw new Error(
      `Playlist snapshot mismatch. Expected ${expectedSnapshotId}, but current snapshot is ${currentSnapshotId ?? 'unavailable'}. No changes were made.`,
    );
  }
}
