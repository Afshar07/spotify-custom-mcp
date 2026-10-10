import type { ISpotifyImage } from './spotify.js';

// ---- Spotify API shapes (all optional fields are tolerated as missing) -----

export interface ISpotifyShow {
  id: string;
  uri: string;
  name: string;
  description?: string | null;
  /** Deprecated by Spotify (Feb 2026); usually absent. */
  publisher?: string | null;
  total_episodes?: number;
  explicit?: boolean;
  languages?: string[];
  media_type?: string;
  images?: ISpotifyImage[];
  external_urls?: Record<string, string>;
  is_externally_hosted?: boolean | null;
}

export interface ISpotifyEpisode {
  id: string;
  uri: string;
  name: string;
  description?: string | null;
  duration_ms?: number;
  release_date?: string;
  release_date_precision?: string;
  explicit?: boolean;
  languages?: string[];
  is_playable?: boolean;
  is_externally_hosted?: boolean;
  restrictions?: { reason?: string };
  external_urls?: Record<string, string>;
  /** Present on search results and saved episodes, absent on show-episode listings. */
  show?: ISpotifyShow | null;
}

export interface ISpotifySavedEpisode {
  added_at?: string;
  episode?: ISpotifyEpisode | null;
}

export interface ISpotifySavedShow {
  added_at?: string;
  show?: ISpotifyShow | null;
}

export interface IGetShowEpisodesOptions {
  limit?: number;
  offset?: number;
  market?: string;
}

export interface ISearchPodcastOptions {
  limit?: number;
  offset?: number;
  market?: string;
}

// ---- Tool-level results ----------------------------------------------------

export enum EPodcastSort {
  SpotifyOrder = 'spotify_order',
  Newest = 'newest',
  Oldest = 'oldest',
}

export interface IShowSummary {
  id: string;
  uri: string;
  name: string;
  description?: string;
  publisher?: string;
  totalEpisodes?: number;
  explicit?: boolean;
  languages?: string[];
  url?: string;
  imageUrl?: string;
}

export interface IEpisodeShowRef {
  id: string;
  name: string;
}

export interface IEpisodeSummary {
  id: string;
  uri: string;
  name: string;
  show?: IEpisodeShowRef;
  description?: string;
  durationMs?: number;
  releaseDate?: string;
  explicit?: boolean;
  /** Only present when Spotify reports the episode as not playable (e.g. market restriction). */
  playable?: false;
  restriction?: string;
  url?: string;
}

export interface ISavedEpisodeSummary extends IEpisodeSummary {
  savedAt?: string;
}

export interface ISavedShowSummary extends IShowSummary {
  savedAt?: string;
}

export interface ISaveEpisodesFailure {
  uri: string;
  reason: string;
}

export interface ISaveEpisodesResult {
  dryRun: boolean;
  requestedUris: string[];
  duplicateInputUris: string[];
  alreadySavedUris: string[];
  /** Saved by this call, or (in a dry run) the URIs that would be saved. */
  newlySavedUris: string[];
  failedUris: ISaveEpisodesFailure[];
}
