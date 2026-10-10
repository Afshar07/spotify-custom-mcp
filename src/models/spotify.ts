import type { ISpotifyEpisode, ISpotifyShow } from './podcast.js';

export interface ISpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface ISpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

export interface ISpotifyArtist {
  id: string;
  name: string;
  uri: string;
  genres?: string[];
  external_urls?: Record<string, string>;
}

export interface ISpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  album_type?: string;
  release_date?: string;
  total_tracks?: number;
  artists?: ISpotifyArtist[];
  images?: ISpotifyImage[];
  external_urls?: Record<string, string>;
}

export interface ISpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  artists: ISpotifyArtist[];
  album: ISpotifyAlbum;
  external_urls?: Record<string, string>;
  type?: string;
  is_local?: boolean;
}

/** Track as returned by `GET /albums/{id}/tracks` (no nested album). */
export interface ISpotifySimplifiedTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit?: boolean;
  artists: ISpotifyArtist[];
  track_number?: number;
  disc_number?: number;
  external_urls?: Record<string, string>;
}

export interface ISpotifyPlaylistItem {
  added_at?: string | null;
  is_local?: boolean;
  item?: ISpotifyTrack | null;
  /** Legacy field name; tolerated when present. */
  track?: ISpotifyTrack | null;
}

export interface ISpotifySavedTrack {
  added_at?: string;
  track?: ISpotifyTrack | null;
}

export interface ISpotifyPlayHistory {
  played_at: string;
  track?: ISpotifyTrack | null;
}

export interface ISpotifyCursors {
  after?: string;
  before?: string;
}

export interface ISpotifyCursorPaging<TItem> {
  items: TItem[];
  limit?: number;
  next?: string | null;
  cursors?: ISpotifyCursors | null;
}

export interface ISpotifyPaging<TItem> {
  href: string;
  items: TItem[];
  limit: number;
  next: string | null;
  offset: number;
  previous: string | null;
  total: number;
}

export interface ISpotifyOwner {
  id: string;
  display_name?: string | null;
}

export interface ISpotifyPlaylistItemsRef {
  total?: number;
}

export interface ISpotifyPlaylist {
  id: string;
  name: string;
  description?: string | null;
  public?: boolean | null;
  collaborative?: boolean;
  snapshot_id?: string;
  owner?: ISpotifyOwner;
  uri?: string;
  /** Current field name for the item count reference. */
  items?: ISpotifyPlaylistItemsRef;
  /** Legacy field name; tolerated when present. */
  tracks?: ISpotifyPlaylistItemsRef;
  external_urls?: Record<string, string>;
}

export interface ISpotifyCurrentUser {
  id: string;
  display_name?: string | null;
}

export interface ISpotifySnapshotResponse {
  snapshot_id: string;
}

export interface ISpotifyPlaylistSnapshot {
  snapshot_id?: string;
}

export interface ISpotifySearchResponse {
  tracks?: ISpotifyPaging<ISpotifyTrack>;
  /** Search pages can contain null entries for unavailable items. */
  shows?: ISpotifyPaging<ISpotifyShow | null>;
  episodes?: ISpotifyPaging<ISpotifyEpisode | null>;
}

export interface ISpotifyErrorBody {
  error?: {
    status?: number;
    message?: string;
  };
  error_description?: string;
}

export type TSpotifyHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ISpotifyScopeRequirement {
  /** Every listed scope must have been granted. */
  allOf?: string[];
  /** At least one listed scope must have been granted. */
  anyOf?: string[];
}

export interface ISpotifyRequestOptions {
  method?: TSpotifyHttpMethod;
  body?: unknown;
  scopes?: ISpotifyScopeRequirement;
}

export interface IGetPlaylistItemsOptions {
  limit?: number;
  offset?: number;
  all?: boolean;
}

export interface IAddPlaylistItemsOptions {
  playlistId: string;
  uris: string[];
  position?: number;
}

export interface IRemovePlaylistItemsOptions {
  playlistId: string;
  uris: string[];
  snapshotId?: string;
}

export interface IReorderPlaylistItemsOptions {
  playlistId: string;
  rangeStart: number;
  insertBefore: number;
  rangeLength?: number;
  snapshotId?: string;
}

export interface IReplacePlaylistItemsOptions {
  playlistId: string;
  uris: string[];
}

export interface IAddLikedTracksResult {
  addedUris: string[];
  alreadySavedUris: string[];
  dryRun?: boolean;
}

export interface ICreatePlaylistOptions {
  name: string;
  description?: string;
  public: boolean;
}

export interface IUpdatePlaylistDetailsOptions {
  playlistId: string;
  name?: string;
  description?: string;
  public?: boolean;
}

export interface IPageOptions {
  limit?: number;
  offset?: number;
}

export interface IGetRecentlyPlayedOptions {
  limit?: number;
  after?: number;
  before?: number;
}

export interface IGetArtistAlbumsOptions extends IPageOptions {
  includeGroups?: string[];
  market?: string;
}

export interface IGetAlbumTracksOptions extends IPageOptions {
  market?: string;
}

export interface ISpotifyClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRateLimitRetries?: number;
  maxRetryAfterSeconds?: number;
  maxServerErrorRetries?: number;
}
