import { z } from 'zod';
import { collectPages } from '../utils/pagination.js';
import {
  errorResult,
  jsonResult,
  summarizeArtist,
  summarizeTrack,
  type IToolContext,
} from './shared.js';

export const RECENTLY_PLAYED_NOTE =
  'Spotify exposes only a limited recent history (at most the last 50 plays); this is not complete listening history.';
export const LIKED_TRACKS_MAX_ITEMS = 500;

export function registerLibraryTools({ registerTool, spotify }: IToolContext): void {
  registerTool(
    'get_top_items',
    {
      description:
        'Get the user\'s top tracks or artists for a time range (short_term ≈ 4 weeks, medium_term ≈ 6 months, long_term ≈ 1 year). Requires the user-top-read scope. Popularity is not returned.',
      inputSchema: {
        type: z.enum(['tracks', 'artists']),
        timeRange: z.enum(['short_term', 'medium_term', 'long_term']).default('medium_term'),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(1000).default(0),
      },
    },
    async ({ type, timeRange, limit, offset }) => {
      try {
        if (type === 'tracks') {
          const page = await spotify.getTopTracks(timeRange, { limit, offset });
          return jsonResult({
            type,
            timeRange,
            total: page.total,
            offset: page.offset,
            items: page.items.map(summarizeTrack),
          });
        }
        const page = await spotify.getTopArtists(timeRange, { limit, offset });
        return jsonResult({
          type,
          timeRange,
          total: page.total,
          offset: page.offset,
          items: page.items.map(summarizeArtist),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'get_recently_played',
    {
      description: `Get recently played tracks with timestamps. Use at most one of after/before (Unix time in milliseconds) to page. ${RECENTLY_PLAYED_NOTE} Requires the user-read-recently-played scope.`,
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        after: z.number().int().min(0).optional().describe('Only plays after this Unix timestamp (ms)'),
        before: z.number().int().min(0).optional().describe('Only plays before this Unix timestamp (ms)'),
      },
    },
    async ({ limit, after, before }) => {
      try {
        const page = await spotify.getRecentlyPlayed({ limit, after, before });
        const items = page.items
          .filter((entry) => entry.track)
          .map((entry) => ({
            playedAt: entry.played_at,
            ...summarizeTrack(entry.track as NonNullable<typeof entry.track>),
          }));
        return jsonResult({
          note: RECENTLY_PLAYED_NOTE,
          count: items.length,
          ...(page.cursors ? { cursors: page.cursors } : {}),
          items,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'get_liked_tracks',
    {
      description: `Read saved (Liked Songs) tracks, newest first. Bounded: fetches at most maxItems (default 50, max ${LIKED_TRACKS_MAX_ITEMS}) starting at offset; use nextOffset to continue. query filters only the retrieved items (case-insensitive match on title, artist, or album), it is not a full-library search. Requires the user-library-read scope.`,
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        maxItems: z.number().int().min(1).max(LIKED_TRACKS_MAX_ITEMS).default(50),
        query: z.string().min(1).optional(),
      },
    },
    async ({ offset, maxItems, query }) => {
      try {
        const collected = await collectPages(
          (pageOffset, limit) => spotify.getSavedTracks({ offset: pageOffset, limit }),
          { offset, pageSize: 50, maxItems },
        );

        const wanted = query?.toLowerCase();
        const items = collected.items
          .filter((saved) => saved.track)
          .map((saved) => ({
            addedAt: saved.added_at,
            ...summarizeTrack(saved.track as NonNullable<typeof saved.track>),
          }))
          .filter(
            (item) =>
              !wanted ||
              [item.name, item.album, ...item.artists].some((value) =>
                value.toLowerCase().includes(wanted),
              ),
          );

        return jsonResult({
          total: collected.total,
          offset,
          retrieved: collected.items.length,
          ...(collected.nextOffset !== undefined ? { nextOffset: collected.nextOffset } : {}),
          ...(wanted ? { matched: items.length } : {}),
          items,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
