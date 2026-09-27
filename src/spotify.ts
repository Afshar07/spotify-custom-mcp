import type { ISpotifyConfig } from './config.js';

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

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
}

export interface ISpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  images?: ISpotifyImage[];
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
}

export interface ISpotifyPlaylistItem {
  added_at?: string | null;
  item?: ISpotifyTrack | null;
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

export interface ISpotifySnapshotResponse {
  snapshot_id: string;
}

export interface ISpotifySearchResponse {
  tracks?: ISpotifyPaging<ISpotifyTrack>;
}

export interface ISpotifyErrorBody {
  error?: {
    status?: number;
    message?: string;
  };
  error_description?: string;
}

export interface ISpotifyRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
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
}

export class SpotifyClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  public constructor(private readonly config: ISpotifyConfig) {}

  public async searchTracks(query: string, limit = 10): Promise<ISpotifyTrack[]> {
    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: String(Math.min(Math.max(limit, 1), 10)),
    });

    const result = await this.request<ISpotifySearchResponse>(
      `/search?${params.toString()}`,
    );

    return result.tracks?.items ?? [];
  }

  public async getPlaylistItems(
    playlistId: string,
    options: IGetPlaylistItemsOptions = {},
  ): Promise<ISpotifyPaging<ISpotifyPlaylistItem>> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    if (!options.all) {
      return this.request<ISpotifyPaging<ISpotifyPlaylistItem>>(
        `/playlists/${encodeURIComponent(playlistId)}/items?limit=${limit}&offset=${offset}`,
      );
    }

    const allItems: ISpotifyPlaylistItem[] = [];
    let currentOffset = offset;
    let lastPage: ISpotifyPaging<ISpotifyPlaylistItem> | null = null;

    do {
      lastPage = await this.request<ISpotifyPaging<ISpotifyPlaylistItem>>(
        `/playlists/${encodeURIComponent(playlistId)}/items?limit=${limit}&offset=${currentOffset}`,
      );
      allItems.push(...lastPage.items);
      currentOffset += lastPage.items.length;
    } while (lastPage.next);

    return {
      ...(lastPage ?? {
        href: '',
        limit,
        next: null,
        offset,
        previous: null,
        total: allItems.length,
      }),
      items: allItems,
      offset,
      limit: allItems.length,
      next: null,
      previous: null,
    };
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

  public async addLikedTracksIfMissing(uris: string[]): Promise<IAddLikedTracksResult> {
    this.assertLibraryBatch(uris);

    const params = new URLSearchParams({ uris: uris.join(',') });
    const saved = await this.request<boolean[]>(
      `/me/library/contains?${params.toString()}`,
    );

    if (saved.length !== uris.length) {
      throw new Error('Spotify returned an unexpected saved-items response.');
    }

    const addedUris = uris.filter((_, index) => !saved[index]);
    if (addedUris.length > 0) {
      const saveParams = new URLSearchParams({ uris: addedUris.join(',') });
      await this.request<void>(`/me/library?${saveParams.toString()}`, {
        method: 'PUT',
      });
    }

    return {
      addedUris,
      alreadySavedUris: uris.filter((_, index) => saved[index]),
    };
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

  private async request<TResponse>(
    path: string,
    options: ISpotifyRequestOptions = {},
  ): Promise<TResponse> {
    const token = await this.getAccessToken();
    const response = await fetch(`${SPOTIFY_API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('retry-after') ?? '1');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(retryAfterSeconds, 1) * 1000),
      );
      return this.request<TResponse>(path, options);
    }

    if (response.status === 401) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
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

      throw new Error(`Spotify API ${response.status}: ${message}`);
    }

    if (response.status === 204) {
      return undefined as TResponse;
    }

    const raw = await response.text();
    if (!raw) {
      return undefined as TResponse;
    }

    return JSON.parse(raw) as TResponse;
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

    const response = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
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

    if (token.refresh_token && token.refresh_token !== this.config.refreshToken) {
      process.stderr.write(
        'Spotify returned a rotated refresh token. Update SPOTIFY_REFRESH_TOKEN in your .env.\n',
      );
    }

    return token.access_token;
  }
}
