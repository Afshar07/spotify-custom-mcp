import {
  EPodcastSort,
  type IEpisodeSummary,
  type ISavedEpisodeSummary,
  type ISavedShowSummary,
  type IShowSummary,
  type ISpotifyEpisode,
  type ISpotifySavedEpisode,
  type ISpotifySavedShow,
  type ISpotifyShow,
} from '../models/podcast.js';

export const DESCRIPTION_MAX_LENGTH = 300;

export function truncateText(value: string | null | undefined, max = DESCRIPTION_MAX_LENGTH): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Spotify search/list pages can contain null entries for unavailable items. */
export function dropNulls<TItem>(items: Array<TItem | null | undefined>): TItem[] {
  return items.filter((item): item is TItem => item !== null && item !== undefined);
}

/** Normalizes a show; absent Spotify fields stay absent instead of being invented. */
export function summarizeShow(show: ISpotifyShow): IShowSummary {
  const description = truncateText(show.description);
  return {
    id: show.id,
    uri: show.uri,
    name: show.name,
    ...(description ? { description } : {}),
    ...(show.publisher ? { publisher: show.publisher } : {}),
    ...(typeof show.total_episodes === 'number' ? { totalEpisodes: show.total_episodes } : {}),
    ...(typeof show.explicit === 'boolean' ? { explicit: show.explicit } : {}),
    ...(show.languages?.length ? { languages: show.languages } : {}),
    ...(show.external_urls?.spotify ? { url: show.external_urls.spotify } : {}),
    ...(show.images?.[0]?.url ? { imageUrl: show.images[0].url } : {}),
  };
}

export function summarizeEpisode(episode: ISpotifyEpisode): IEpisodeSummary {
  const description = truncateText(episode.description);
  return {
    id: episode.id,
    uri: episode.uri,
    name: episode.name,
    ...(episode.show?.id ? { show: { id: episode.show.id, name: episode.show.name } } : {}),
    ...(description ? { description } : {}),
    ...(typeof episode.duration_ms === 'number' ? { durationMs: episode.duration_ms } : {}),
    ...(episode.release_date ? { releaseDate: episode.release_date } : {}),
    ...(typeof episode.explicit === 'boolean' ? { explicit: episode.explicit } : {}),
    ...(episode.is_playable === false ? { playable: false as const } : {}),
    ...(episode.restrictions?.reason ? { restriction: episode.restrictions.reason } : {}),
    ...(episode.external_urls?.spotify ? { url: episode.external_urls.spotify } : {}),
  };
}

export function summarizeSavedEpisodes(items: ISpotifySavedEpisode[]): ISavedEpisodeSummary[] {
  return items
    .filter((saved): saved is ISpotifySavedEpisode & { episode: ISpotifyEpisode } => Boolean(saved.episode))
    .map((saved) => ({
      ...(saved.added_at ? { savedAt: saved.added_at } : {}),
      ...summarizeEpisode(saved.episode),
    }));
}

export function summarizeSavedShows(items: ISpotifySavedShow[]): ISavedShowSummary[] {
  return items
    .filter((saved): saved is ISpotifySavedShow & { show: ISpotifyShow } => Boolean(saved.show))
    .map((saved) => ({
      ...(saved.added_at ? { savedAt: saved.added_at } : {}),
      ...summarizeShow(saved.show),
    }));
}

/**
 * Sortable key for Spotify release dates, which may be `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
 * Missing or malformed dates return undefined and sort last.
 */
export function releaseDateKey(releaseDate: string | undefined): string | undefined {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(releaseDate ?? '');
  return match ? `${match[1]}-${match[2] ?? '01'}-${match[3] ?? '01'}` : undefined;
}

/**
 * Orders only the supplied items (never the whole show archive). Stable; episodes without a
 * usable release date are placed last in both directions.
 */
export function sortEpisodes<TEpisode extends { releaseDate?: string }>(
  episodes: TEpisode[],
  sort: EPodcastSort,
): TEpisode[] {
  if (sort === EPodcastSort.SpotifyOrder) {
    return [...episodes];
  }
  const direction = sort === EPodcastSort.Newest ? -1 : 1;
  return episodes
    .map((episode, index) => ({ episode, index, key: releaseDateKey(episode.releaseDate) }))
    .sort((a, b) => {
      if (a.key === undefined || b.key === undefined) {
        return a.key === b.key ? a.index - b.index : a.key === undefined ? 1 : -1;
      }
      return a.key === b.key ? a.index - b.index : a.key < b.key ? -direction : direction;
    })
    .map((entry) => entry.episode);
}

/** Case-insensitive match on name, description, and show name within already-retrieved items. */
export function filterEpisodesByQuery<TEpisode extends IEpisodeSummary>(
  episodes: TEpisode[],
  query: string | undefined,
): TEpisode[] {
  const wanted = query?.trim().toLowerCase();
  if (!wanted) {
    return episodes;
  }
  return episodes.filter((episode) =>
    [episode.name, episode.description, episode.show?.name].some((value) =>
      value?.toLowerCase().includes(wanted),
    ),
  );
}

export function filterShowsByQuery<TShow extends IShowSummary>(
  shows: TShow[],
  query: string | undefined,
): TShow[] {
  const wanted = query?.trim().toLowerCase();
  if (!wanted) {
    return shows;
  }
  return shows.filter((show) =>
    [show.name, show.description, show.publisher].some((value) => value?.toLowerCase().includes(wanted)),
  );
}
