import type { ISpotifyConfig } from './config.js';
import type {
  IAddLikedTracksResult,
  IAddPlaylistItemsOptions,
  ICreatePlaylistOptions,
  IGetAlbumTracksOptions,
  IGetArtistAlbumsOptions,
  IGetPlaylistItemsOptions,
  IGetRecentlyPlayedOptions,
  IPageOptions,
  IRemovePlaylistItemsOptions,
  IReorderPlaylistItemsOptions,
  IReplacePlaylistItemsOptions,
  ISpotifyAlbum,
  ISpotifyArtist,
  ISpotifyClientOptions,
  ISpotifyCurrentUser,
  ISpotifyCursorPaging,
  ISpotifyErrorBody,
  ISpotifyPaging,
  ISpotifyPlayHistory,
  ISpotifyPlaylist,
  ISpotifyPlaylistItem,
  ISpotifyPlaylistSnapshot,
  ISpotifyRequestOptions,
  ISpotifySavedTrack,
  ISpotifyScopeRequirement,
  ISpotifySearchResponse,
  ISpotifySimplifiedTrack,
  ISpotifySnapshotResponse,
  ISpotifyTokenResponse,
  ISpotifyTrack,
  IUpdatePlaylistDetailsOptions,
} from './models/spotify.js';
import type {
  IGetShowEpisodesOptions,
  ISearchPodcastOptions,
  ISpotifyEpisode,
  ISpotifySavedEpisode,
  ISpotifySavedShow,
  ISpotifyShow,
} from './models/podcast.js';
import {
  SCOPE_LIBRARY_MODIFY,
  SCOPE_LIBRARY_READ,
  SCOPE_PLAYLIST_MODIFY_PRIVATE,
  SCOPE_PLAYLIST_MODIFY_PUBLIC,
  SCOPE_PLAYLIST_READ_PRIVATE,
  SCOPE_RECENTLY_PLAYED,
  SCOPE_TOP_READ,
} from './scopes.js';
import { collectPages } from './utils/pagination.js';

export type * from './models/spotify.js';

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30;
const DEFAULT_MAX_SERVER_ERROR_RETRIES = 2;
/** Spotify caps playlists at 10,000 items; this bounds an `all` read defensively. */
const MAX_ALL_PLAYLIST_ITEMS = 11_000;

export class SpotifyApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Spotify API ${status}: ${message}`);
    this.name = 'SpotifyApiError';
  }
}

export class SpotifyScopeError extends Error {
  public constructor(public readonly missingScopes: string[]) {
    super(
      `Missing Spotify OAuth scope(s): ${missingScopes.join(', ')}. Re-run \`npm run auth\` and update SPOTIFY_REFRESH_TOKEN. No request was sent.`,
    );
    this.name = 'SpotifyScopeError';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function emptyPage<TItem>(offset = 0): ISpotifyPaging<TItem> {
  return { href: '', items: [], limit: 0, next: null, offset, previous: null, total: 0 };
}

export class SpotifyClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private grantedScopes: Set<string> | null = null;
  private currentUser: ISpotifyCurrentUser | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly maxServerErrorRetries: number;

  public constructor(
    private readonly config: ISpotifyConfig,
    options: ISpotifyClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;
    this.maxServerErrorRetries = options.maxServerErrorRetries ?? DEFAULT_MAX_SERVER_ERROR_RETRIES;
  }

  // ---- Search -----------------------------------------------------------

  public async searchTracks(query: string, limit = 10): Promise<ISpotifyTrack[]> {
    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: String(clamp(limit, 1, 10)),
    });

    const result = await this.request<ISpotifySearchResponse>(
      `/search?${params.toString()}`,
    );

    return result.tracks?.items ?? [];
  }

  public async getTrack(trackId: string): Promise<ISpotifyTrack> {
    return this.request<ISpotifyTrack>(`/tracks/${encodeURIComponent(trackId)}`);
  }

  // ---- Playlists: reads -------------------------------------------------

  public async getPlaylistItems(
    playlistId: string,
    options: IGetPlaylistItemsOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyPlaylistItem>> {
    const limit = clamp(options.limit ?? 100, 1, 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const fetchPage = (pageOffset: number, pageLimit: number) =>
      this.request<ISpotifyPaging<ISpotifyPlaylistItem>>(
        `/playlists/${encodeURIComponent(playlistId)}/items?limit=${pageLimit}&offset=${pageOffset}`,
      );

    if (!options.all) {
      return fetchPage(offset, limit);
    }

    const collected = await collectPages(fetchPage, {
      offset,
      pageSize: limit,
      maxItems: MAX_ALL_PLAYLIST_ITEMS,
    });

    return {
      href: '',
      items: collected.items,
      offset,
      limit: collected.items.length,
      next: null,
      previous: null,
      total: collected.total ?? collected.items.length,
    };
  }

  public async getPlaylistSnapshot(playlistId: string): Promise<string | undefined> {
    const playlist = await this.request<ISpotifyPlaylistSnapshot>(
      `/playlists/${encodeURIComponent(playlistId)}?fields=snapshot_id`,
    );
    return playlist.snapshot_id;
  }

  public async getPlaylist(playlistId: string): Promise<ISpotifyPlaylist> {
    const fields =
      'id,name,description,public,collaborative,snapshot_id,uri,owner(id,display_name),external_urls';
    return this.request<ISpotifyPlaylist>(
      `/playlists/${encodeURIComponent(playlistId)}?fields=${encodeURIComponent(fields)}`,
    );
  }

  public async getCurrentUser(): Promise<ISpotifyCurrentUser> {
    if (!this.currentUser) {
      this.currentUser = await this.request<ISpotifyCurrentUser>('/me');
    }
    return this.currentUser;
  }

  public async getMyPlaylists(
    options: IPageOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyPlaylist>> {
    const params = this.pageParams(options, 50);
    return this.request<ISpotifyPaging<ISpotifyPlaylist>>(
      `/me/playlists?${params.toString()}`,
      { scopes: { allOf: [SCOPE_PLAYLIST_READ_PRIVATE] } },
    );
  }

  // ---- Playlists: writes ------------------------------------------------

  public async createPlaylist(options: ICreatePlaylistOptions): Promise<ISpotifyPlaylist> {
    return this.request<ISpotifyPlaylist>('/me/playlists', {
      method: 'POST',
      body: {
        name: options.name,
        public: options.public,
        ...(options.description !== undefined ? { description: options.description } : {}),
      },
      scopes: {
        allOf: [options.public ? SCOPE_PLAYLIST_MODIFY_PUBLIC : SCOPE_PLAYLIST_MODIFY_PRIVATE],
      },
    });
  }

  public async updatePlaylistDetails(options: IUpdatePlaylistDetailsOptions): Promise<void> {
    await this.request<void>(`/playlists/${encodeURIComponent(options.playlistId)}`, {
      method: 'PUT',
      body: {
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.public !== undefined ? { public: options.public } : {}),
      },
      scopes: { anyOf: [SCOPE_PLAYLIST_MODIFY_PUBLIC, SCOPE_PLAYLIST_MODIFY_PRIVATE] },
    });
  }

  public async addPlaylistItems(
    options: IAddPlaylistItemsOptions,
  ): Promise<ISpotifySnapshotResponse> {
    this.assertMutationBatch(options.uris);
    const params = new URLSearchParams();
    if (options.position !== undefined) {
      params.set('position', String(options.position));
    }

    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request<ISpotifySnapshotResponse>(
      `/playlists/${encodeURIComponent(options.playlistId)}/items${suffix}`,
      {
        method: 'POST',
        body: { uris: options.uris },
      },
    );
  }

  public async removePlaylistItems(
    options: IRemovePlaylistItemsOptions,
  ): Promise<ISpotifySnapshotResponse> {
    this.assertMutationBatch(options.uris);

    return this.request<ISpotifySnapshotResponse>(
      `/playlists/${encodeURIComponent(options.playlistId)}/items`,
      {
        method: 'DELETE',
        body: {
          items: options.uris.map((uri) => ({ uri })),
          ...(options.snapshotId ? { snapshot_id: options.snapshotId } : {}),
        },
      },
    );
  }

  public async reorderPlaylistItems(
    options: IReorderPlaylistItemsOptions,
  ): Promise<ISpotifySnapshotResponse> {
    return this.request<ISpotifySnapshotResponse>(
      `/playlists/${encodeURIComponent(options.playlistId)}/items`,
      {
        method: 'PUT',
        body: {
          range_start: options.rangeStart,
          insert_before: options.insertBefore,
          ...(options.rangeLength !== undefined
            ? { range_length: options.rangeLength }
            : {}),
          ...(options.snapshotId ? { snapshot_id: options.snapshotId } : {}),
        },
      },
    );
  }

  public async replacePlaylistItems(
    options: IReplacePlaylistItemsOptions,
  ): Promise<ISpotifySnapshotResponse> {
    this.assertMutationBatch(options.uris);

    return this.request<ISpotifySnapshotResponse>(
      `/playlists/${encodeURIComponent(options.playlistId)}/items`,
      {
        method: 'PUT',
        body: { uris: options.uris },
      },
    );
  }

  // ---- Library, listening history, discovery ---------------------------

  public async addLikedTracksIfMissing(
    uris: string[],
    dryRun = false,
  ): Promise<IAddLikedTracksResult> {
    this.assertLibraryBatch(uris);

    const params = new URLSearchParams({ uris: uris.join(',') });
    const saved = await this.request<boolean[]>(
      `/me/library/contains?${params.toString()}`,
    );

    if (saved.length !== uris.length) {
      throw new Error('Spotify returned an unexpected saved-items response.');
    }

    const addedUris = uris.filter((_, index) => !saved[index]);
    if (addedUris.length > 0 && !dryRun) {
      const saveParams = new URLSearchParams({ uris: addedUris.join(',') });
      await this.request<void>(`/me/library?${saveParams.toString()}`, {
        method: 'PUT',
      });
    }

    return {
      addedUris,
      alreadySavedUris: uris.filter((_, index) => saved[index]),
      ...(dryRun ? { dryRun: true } : {}),
    };
  }

  public async getSavedTracks(
    options: IPageOptions = {},
  ): Promise<ISpotifyPaging<ISpotifySavedTrack>> {
    const params = this.pageParams(options, 50);
    return this.request<ISpotifyPaging<ISpotifySavedTrack>>(
      `/me/tracks?${params.toString()}`,
      { scopes: { allOf: [SCOPE_LIBRARY_READ] } },
    );
  }

  public async getTopTracks(
    timeRange: string,
    options: IPageOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyTrack>> {
    const params = this.pageParams(options, 50);
    params.set('time_range', timeRange);
    return this.request<ISpotifyPaging<ISpotifyTrack>>(
      `/me/top/tracks?${params.toString()}`,
      { scopes: { allOf: [SCOPE_TOP_READ] } },
    );
  }

  public async getTopArtists(
    timeRange: string,
    options: IPageOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyArtist>> {
    const params = this.pageParams(options, 50);
    params.set('time_range', timeRange);
    return this.request<ISpotifyPaging<ISpotifyArtist>>(
      `/me/top/artists?${params.toString()}`,
      { scopes: { allOf: [SCOPE_TOP_READ] } },
    );
  }

  public async getRecentlyPlayed(
    options: IGetRecentlyPlayedOptions = {},
  ): Promise<ISpotifyCursorPaging<ISpotifyPlayHistory>> {
    if (options.after !== undefined && options.before !== undefined) {
      throw new Error('Spotify accepts only one of "after" and "before" for recently played tracks.');
    }
    const params = new URLSearchParams({
      limit: String(clamp(options.limit ?? 20, 1, 50)),
    });
    if (options.after !== undefined) {
      params.set('after', String(options.after));
    }
    if (options.before !== undefined) {
      params.set('before', String(options.before));
    }
    return this.request<ISpotifyCursorPaging<ISpotifyPlayHistory>>(
      `/me/player/recently-played?${params.toString()}`,
      { scopes: { allOf: [SCOPE_RECENTLY_PLAYED] } },
    );
  }

  public async getArtistAlbums(
    artistId: string,
    options: IGetArtistAlbumsOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyAlbum>> {
    const params = this.pageParams(options, 50);
    if (options.includeGroups?.length) {
      params.set('include_groups', options.includeGroups.join(','));
    }
    if (options.market) {
      params.set('market', options.market);
    }
    return this.request<ISpotifyPaging<ISpotifyAlbum>>(
      `/artists/${encodeURIComponent(artistId)}/albums?${params.toString()}`,
    );
  }

  public async getAlbumTracks(
    albumId: string,
    options: IGetAlbumTracksOptions = {},
  ): Promise<ISpotifyPaging<ISpotifySimplifiedTrack>> {
    const params = this.pageParams(options, 50);
    if (options.market) {
      params.set('market', options.market);
    }
    return this.request<ISpotifyPaging<ISpotifySimplifiedTrack>>(
      `/albums/${encodeURIComponent(albumId)}/tracks?${params.toString()}`,
    );
  }

  // ---- Podcasts ---------------------------------------------------------

  public async searchShows(
    query: string,
    options: ISearchPodcastOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyShow | null>> {
    const result = await this.search(query, 'show', options);
    return result.shows ?? emptyPage(options.offset);
  }

  public async searchEpisodes(
    query: string,
    options: ISearchPodcastOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyEpisode | null>> {
    const result = await this.search(query, 'episode', options);
    return result.episodes ?? emptyPage(options.offset);
  }

  public async getShow(showId: string, market?: string): Promise<ISpotifyShow> {
    const params = new URLSearchParams();
    if (market) {
      params.set('market', market);
    }
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request<ISpotifyShow>(`/shows/${encodeURIComponent(showId)}${suffix}`);
  }

  public async getShowEpisodes(
    showId: string,
    options: IGetShowEpisodesOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyEpisode | null>> {
    const params = this.pageParams(options, 50);
    if (options.market) {
      params.set('market', options.market);
    }
    return this.request<ISpotifyPaging<ISpotifyEpisode | null>>(
      `/shows/${encodeURIComponent(showId)}/episodes?${params.toString()}`,
    );
  }

  public async getSavedEpisodes(
    options: IPageOptions = {},
  ): Promise<ISpotifyPaging<ISpotifySavedEpisode>> {
    const params = this.pageParams(options, 50);
    return this.request<ISpotifyPaging<ISpotifySavedEpisode>>(
      `/me/episodes?${params.toString()}`,
      { scopes: { allOf: [SCOPE_LIBRARY_READ] } },
    );
  }

  public async getSavedShows(
    options: IPageOptions = {},
  ): Promise<ISpotifyPaging<ISpotifySavedShow>> {
    const params = this.pageParams(options, 50);
    return this.request<ISpotifyPaging<ISpotifySavedShow>>(
      `/me/shows?${params.toString()}`,
      { scopes: { allOf: [SCOPE_LIBRARY_READ] } },
    );
  }

  /** `GET /me/library/contains` for up to 40 URIs; the result is index-aligned with `uris`. */
  public async checkLibraryContains(uris: string[]): Promise<boolean[]> {
    this.assertLibraryBatch(uris);
    const params = new URLSearchParams({ uris: uris.join(',') });
    const saved = await this.request<boolean[]>(`/me/library/contains?${params.toString()}`, {
      scopes: { allOf: [SCOPE_LIBRARY_READ] },
    });
    if (!Array.isArray(saved) || saved.length !== uris.length) {
      throw new Error('Spotify returned an unexpected saved-items response.');
    }
    return saved;
  }

  /** `PUT /me/library` for up to 40 URIs. Never retried after an unknown outcome. */
  public async saveToLibrary(uris: string[]): Promise<void> {
    this.assertLibraryBatch(uris);
    const params = new URLSearchParams({ uris: uris.join(',') });
    await this.request<void>(`/me/library?${params.toString()}`, {
      method: 'PUT',
      scopes: { allOf: [SCOPE_LIBRARY_MODIFY] },
    });
  }

  // ---- Internals --------------------------------------------------------

  private search(
    query: string,
    type: 'show' | 'episode',
    options: ISearchPodcastOptions,
  ): Promise<ISpotifySearchResponse> {
    const params = new URLSearchParams({
      q: query,
      type,
      limit: String(clamp(options.limit ?? 5, 1, 10)),
      offset: String(clamp(options.offset ?? 0, 0, 1000)),
    });
    if (options.market) {
      params.set('market', options.market);
    }
    return this.request<ISpotifySearchResponse>(`/search?${params.toString()}`);
  }

  private pageParams(options: IPageOptions, maxLimit: number): URLSearchParams {
    return new URLSearchParams({
      limit: String(clamp(options.limit ?? 20, 1, maxLimit)),
      offset: String(Math.max(options.offset ?? 0, 0)),
    });
  }

  private assertMutationBatch(uris: string[]): void {
    if (uris.length > 100) {
      throw new Error('Spotify playlist mutation endpoints accept at most 100 URIs per request.');
    }
  }

  private assertLibraryBatch(uris: string[]): void {
    if (uris.length > 40) {
      throw new Error('Spotify saved-library endpoints accept at most 40 URIs per request.');
    }
  }

  private assertScopes(requirement: ISpotifyScopeRequirement | undefined): void {
    if (!requirement || !this.grantedScopes) {
      return;
    }
    const granted = this.grantedScopes;
    const missingAll = (requirement.allOf ?? []).filter((scope) => !granted.has(scope));
    if (missingAll.length > 0) {
      throw new SpotifyScopeError(missingAll);
    }
    if (requirement.anyOf?.length && !requirement.anyOf.some((scope) => granted.has(scope))) {
      throw new SpotifyScopeError(requirement.anyOf);
    }
  }

  private async request<TResponse>(
    path: string,
    options: ISpotifyRequestOptions = {},
  ): Promise<TResponse> {
    const method = options.method ?? 'GET';
    const isRead = method === 'GET';
    let rateLimitRetries = 0;
    let serverErrorRetries = 0;
    let refreshedAfter401 = false;

    for (;;) {
      const token = await this.getAccessToken();
      this.assertScopes(options.scopes);

      let response: Response;
      try {
        response = await this.fetchImpl(`${SPOTIFY_API_BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body !== undefined
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (isRead && serverErrorRetries < this.maxServerErrorRetries) {
          serverErrorRetries += 1;
          await this.sleep(500 * serverErrorRetries);
          continue;
        }
        const reason = error instanceof Error ? error.name : 'network error';
        throw new Error(
          isRead
            ? `Spotify request failed (${reason}).`
            : `Spotify ${method} request failed (${reason}). The outcome is unknown and the request was not retried; re-read the current state before trying again.`,
        );
      }

      if (response.status === 429) {
        const parsed = Number(response.headers.get('retry-after') ?? '1');
        const retryAfterSeconds = Math.max(Number.isFinite(parsed) ? parsed : 1, 1);
        if (
          rateLimitRetries >= this.maxRateLimitRetries ||
          retryAfterSeconds > this.maxRetryAfterSeconds
        ) {
          throw new SpotifyApiError(
            429,
            `Rate limited by Spotify. Retry after ${retryAfterSeconds} seconds.`,
          );
        }
        rateLimitRetries += 1;
        await this.sleep(retryAfterSeconds * 1000);
        continue;
      }

      if (response.status === 401) {
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        if (!refreshedAfter401) {
          refreshedAfter401 = true;
          continue;
        }
      }

      if (response.status >= 500 && isRead && serverErrorRetries < this.maxServerErrorRetries) {
        serverErrorRetries += 1;
        await this.sleep(500 * serverErrorRetries);
        continue;
      }

      if (!response.ok) {
        const raw = await response.text();
        let message = raw || response.statusText;

        try {
          const body = JSON.parse(raw) as ISpotifyErrorBody;
          message = body.error?.message ?? body.error_description ?? message;
        } catch {
          // Keep the raw response when Spotify did not return JSON.
        }

        if (response.status === 403) {
          message +=
            ' (This can mean a missing OAuth scope — re-run `npm run auth` — or that the playlist or endpoint is not accessible to this Development Mode app.)';
        }
        if (response.status >= 500 && !isRead) {
          message +=
            ' (The change may or may not have been applied; re-read the current state before retrying.)';
        }

        throw new SpotifyApiError(response.status, message);
      }

      if (response.status === 204) {
        return undefined as TResponse;
      }

      const raw = await response.text();
      if (!raw) {
        return undefined as TResponse;
      }

      try {
        return JSON.parse(raw) as TResponse;
      } catch {
        throw new Error('Spotify returned a response that is not valid JSON.');
      }
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 30_000) {
      return this.accessToken;
    }

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
    });

    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64');

    const response = await this.fetchImpl(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ISpotifyErrorBody;
      throw new Error(
        `Spotify token refresh failed (${response.status}): ${body.error_description ?? response.statusText}`,
      );
    }

    const token = (await response.json()) as ISpotifyTokenResponse;
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = Date.now() + token.expires_in * 1000;
    this.grantedScopes = token.scope ? new Set(token.scope.split(/\s+/).filter(Boolean)) : null;

    if (token.refresh_token && token.refresh_token !== this.config.refreshToken) {
      process.stderr.write(
        'Spotify returned a rotated refresh token. Update SPOTIFY_REFRESH_TOKEN in your .env.\n',
      );
    }

    return token.access_token;
  }
}
