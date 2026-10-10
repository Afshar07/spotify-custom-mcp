import { z } from 'zod';

const TRACK_URI = /^spotify:track:[A-Za-z0-9]+$/;
const PLAYLIST_ITEM_URI = /^spotify:(?:track|episode):[A-Za-z0-9]+$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{1,64}$/;

export const spotifyPlaylistItemUriSchema = z
  .string()
  .regex(PLAYLIST_ITEM_URI, 'Expected a Spotify track or episode URI.');

export const spotifyTrackUriSchema = z
  .string()
  .regex(TRACK_URI, 'Expected a Spotify track URI.');

export const spotifyIdSchema = z
  .string()
  .regex(SPOTIFY_ID, 'Expected a Spotify ID (not a URL or URI).');

export function isTrackUri(value: string): boolean {
  return TRACK_URI.test(value);
}

export function isPlaylistItemUri(value: string): boolean {
  return PLAYLIST_ITEM_URI.test(value);
}

/** Extracts the ID from a `spotify:<type>:<id>` URI, or undefined if malformed. */
export function idFromUri(uri: string): string | undefined {
  const match = /^spotify:[a-z]+:([A-Za-z0-9]+)$/.exec(uri);
  return match?.[1];
}

/** Splits values into order-preserving unique entries and the repeats that were dropped. */
export function dedupePreservingOrder(values: string[]): {
  unique: string[];
  duplicates: string[];
} {
  const seen = new Set<string>();
  const unique: string[] = [];
  const duplicates: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.push(value);
    } else {
      seen.add(value);
      unique.push(value);
    }
  }
  return { unique, duplicates };
}

export function chunk<TItem>(values: TItem[], size: number): TItem[][] {
  const chunks: TItem[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
