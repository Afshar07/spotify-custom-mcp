import { z } from 'zod';
import { EPodcastSort } from '../models/podcast.js';
import {
  dropNulls,
  filterEpisodesByQuery,
  filterShowsByQuery,
  sortEpisodes,
  summarizeEpisode,
  summarizeSavedEpisodes,
  summarizeSavedShows,
  summarizeShow,
} from '../services/podcast-discovery.js';
import { saveEpisodes } from '../services/podcast-library.js';
import { SpotifyApiError } from '../spotify.js';
import { collectPages } from '../utils/pagination.js';
import { spotifyEpisodeUriSchema, spotifyIdSchema } from '../utils/uri.js';
import { errorResult, jsonErrorResult, jsonResult, type IToolContext } from './shared.js';

export const SAVED_PODCAST_MAX_ITEMS = 500;
export const SAVED_EPISODES_NOTE =
  'These are episodes explicitly saved to the library (GET /me/episodes). They are not listening history or recently played content, and query filters only the retrieved items.';
export const SORT_NOTE =
  'Sorting is applied only to the episodes returned in this page, not to the whole show archive. Use offset/nextOffset to read further pages.';

const marketSchema = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'Expected an ISO 3166-1 alpha-2 country code.')
  .transform((value) => value.toUpperCase())
  .optional();

/** Adds a podcast-specific hint to lookup failures that usually mean "unavailable here". */
function podcastErrorResult(error: unknown) {
  if (error instanceof SpotifyApiError && (error.status === 400 || error.status === 404)) {
    return errorResult(
      new Error(
        `${error.message} (The show or episode may not exist or may be unavailable in this market; check the ID or pass a market.)`,
      ),
    );
  }
  return errorResult(error);
}

function pageInfo(page: { total: number; offset: number; next: string | null }, returned: number) {
  return {
    total: page.total,
    offset: page.offset,
    returned,
    ...(page.next ? { nextOffset: page.offset + returned } : {}),
  };
}

export function registerPodcastTools({ registerTool, spotify }: IToolContext): void {
  const searchShape = {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(10).default(5),
    offset: z.number().int().min(0).max(1000).default(0),
    market: marketSchema,
  };

  registerTool(
    'search_podcasts',
    {
      description:
        'Search Spotify podcasts (shows, not music tracks). Returns show IDs/URIs, truncated descriptions and Spotify links. Search returns at most 10 results per call; page with offset. Unavailable results are omitted and counted. Publisher is often missing because Spotify deprecated it.',
      inputSchema: searchShape,
    },
    async ({ query, limit, offset, market }) => {
      try {
        const page = await spotify.searchShows(query, { limit, offset, market });
        const items = dropNulls(page.items).map(summarizeShow);
        return jsonResult({
          ...pageInfo(page, page.items.length),
          unavailable: page.items.length - items.length,
          items,
        });
      } catch (error) {
        return podcastErrorResult(error);
      }
    },
  );

  registerTool(
    'search_episodes',
    {
      description:
        'Search individual podcast episodes (not music tracks; use search_tracks for songs). Returns episode URIs usable with save_episode, show name, duration, release date and Spotify links. Search returns at most 10 results per call; page with offset. Episodes with playable:false are restricted in the market.',
      inputSchema: searchShape,
    },
    async ({ query, limit, offset, market }) => {
      try {
        const page = await spotify.searchEpisodes(query, { limit, offset, market });
        const items = dropNulls(page.items).map(summarizeEpisode);
        return jsonResult({
          ...pageInfo(page, page.items.length),
          unavailable: page.items.length - items.length,
          items,
        });
      } catch (error) {
        return podcastErrorResult(error);
      }
    },
  );

  registerTool(
    'get_podcast_details',
    {
      description:
        'Get metadata for one podcast show by Spotify show ID: description, languages, total episode count, explicit flag and Spotify link.',
      inputSchema: { showId: spotifyIdSchema, market: marketSchema },
    },
    async ({ showId, market }) => {
      try {
        return jsonResult(summarizeShow(await spotify.getShow(showId, market)));
      } catch (error) {
        return podcastErrorResult(error);
      }
    },
  );

  registerTool(
    'get_podcast_episodes',
    {
      description: `Read one page of a show's episodes (limit ≤ 50) via GET /shows/{id}/episodes; never the whole archive. Use offset/nextOffset to continue. sort=newest|oldest reorders only the returned page (Spotify offers no server-side sort); spotify_order keeps Spotify's order. Set includeShow=false on later pages to skip the extra show-metadata request. ${SORT_NOTE}`,
      inputSchema: {
        showId: spotifyIdSchema,
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        market: marketSchema,
        sort: z.nativeEnum(EPodcastSort).default(EPodcastSort.SpotifyOrder),
        includeShow: z.boolean().default(true),
      },
    },
    async ({ showId, limit, offset, market, sort, includeShow }) => {
      try {
        const [show, page] = await Promise.all([
          includeShow ? spotify.getShow(showId, market) : Promise.resolve(undefined),
          spotify.getShowEpisodes(showId, { limit, offset, market }),
        ]);
        const episodes = sortEpisodes(dropNulls(page.items).map(summarizeEpisode), sort);
        return jsonResult({
          ...(show ? { show: summarizeShow(show) } : {}),
          ...pageInfo(page, page.items.length),
          unavailable: page.items.length - episodes.length,
          sort,
          ...(sort !== EPodcastSort.SpotifyOrder ? { sortScope: 'returned page only' } : {}),
          episodes,
        });
      } catch (error) {
        return podcastErrorResult(error);
      }
    },
  );

  registerTool(
    'get_saved_episodes',
    {
      description: `Read the user's saved podcast episodes (GET /me/episodes), bounded by maxItems (default 50, max ${SAVED_PODCAST_MAX_ITEMS}) starting at offset; limit is the page size per Spotify request. Includes savedAt and show info. query filters only the retrieved items (title, description, show name). ${SAVED_EPISODES_NOTE} Requires the user-library-read scope.`,
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(50),
        offset: z.number().int().min(0).default(0),
        maxItems: z.number().int().min(1).max(SAVED_PODCAST_MAX_ITEMS).default(50),
        query: z.string().min(1).optional(),
      },
    },
    async ({ limit, offset, maxItems, query }) => {
      try {
        const collected = await collectPages(
          (pageOffset, pageLimit) => spotify.getSavedEpisodes({ offset: pageOffset, limit: pageLimit }),
          { offset, pageSize: limit, maxItems },
        );
        const retrieved = summarizeSavedEpisodes(collected.items);
        const items = filterEpisodesByQuery(retrieved, query);
        return jsonResult({
          note: SAVED_EPISODES_NOTE,
          total: collected.total,
          offset,
          retrieved: collected.items.length,
          ...(collected.nextOffset !== undefined ? { nextOffset: collected.nextOffset } : {}),
          ...(query ? { matched: items.length } : {}),
          items,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'get_saved_podcasts',
    {
      description: `Read podcast shows saved/followed in the user's library (GET /me/shows), bounded by maxItems (default 50, max ${SAVED_PODCAST_MAX_ITEMS}) starting at offset. query filters only the retrieved shows. Requires the user-library-read scope.`,
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        maxItems: z.number().int().min(1).max(SAVED_PODCAST_MAX_ITEMS).default(50),
        query: z.string().min(1).optional(),
      },
    },
    async ({ offset, maxItems, query }) => {
      try {
        const collected = await collectPages(
          (pageOffset, pageLimit) => spotify.getSavedShows({ offset: pageOffset, limit: pageLimit }),
          { offset, pageSize: 50, maxItems },
        );
        const items = filterShowsByQuery(summarizeSavedShows(collected.items), query);
        return jsonResult({
          total: collected.total,
          offset,
          retrieved: collected.items.length,
          ...(collected.nextOffset !== undefined ? { nextOffset: collected.nextOffset } : {}),
          ...(query ? { matched: items.length } : {}),
          items,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'save_episode',
    {
      description:
        'Save podcast episodes to the user\'s Spotify library (PUT /me/library). Accepts spotify:episode:<id> URIs only (use add_liked_tracks for songs). Always reads first (GET /me/library/contains), skips episodes already saved and duplicate inputs, and writes in batches of 40. dryRun defaults to TRUE: it previews newlySavedUris without writing; only call with dryRun=false after the user approves the preview. Partial failures are returned in failedUris with isError. Requires user-library-read and user-library-modify scopes.',
      inputSchema: {
        episodeUris: z.array(spotifyEpisodeUriSchema).min(1).max(100),
        dryRun: z.boolean().default(true),
      },
    },
    async ({ episodeUris, dryRun }) => {
      try {
        const result = await saveEpisodes(spotify, episodeUris, dryRun);
        return result.failedUris.length > 0 ? jsonErrorResult(result) : jsonResult(result);
      } catch (error) {
        return podcastErrorResult(error);
      }
    },
  );
}
