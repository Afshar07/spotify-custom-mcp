import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../src/mcp-server.js';
import { REQUESTED_SCOPES } from '../../src/scopes.js';
import { SpotifyClient } from '../../src/spotify.js';
import type { ISpotifyClientOptions, ISpotifyPaging } from '../../src/models/spotify.js';

export interface IRecordedRequest {
  method: string;
  /** Path without the API base, e.g. `/playlists/abc/items`. */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface IFakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type TFakeHandler = (request: IRecordedRequest) => IFakeResponse | unknown;

export interface IFakeRoute {
  method: string;
  pattern: string | RegExp;
  handler: TFakeHandler;
}

export interface IFakeTokenOptions {
  scope?: string;
  expiresIn?: number;
}

const API_PREFIX = 'https://api.spotify.com/v1';

function isFakeResponse(value: unknown): value is IFakeResponse {
  return typeof value === 'object' && value !== null && ('status' in value || 'headers' in value);
}

export class FakeSpotify {
  public readonly requests: IRecordedRequest[] = [];
  public tokenRequests = 0;
  public readonly fetch: typeof fetch;
  private readonly routes: IFakeRoute[] = [];
  public tokenOptions: IFakeTokenOptions = {};

  public constructor() {
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'accounts.spotify.com') {
        this.tokenRequests += 1;
        return this.json({
          access_token: `token-${this.tokenRequests}`,
          token_type: 'Bearer',
          expires_in: this.tokenOptions.expiresIn ?? 3600,
          scope: this.tokenOptions.scope ?? REQUESTED_SCOPES.join(' '),
        });
      }

      const request: IRecordedRequest = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace('/v1', ''),
        query: url.searchParams,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      this.requests.push(request);

      const route = this.routes.find(
        (candidate) =>
          candidate.method === request.method &&
          (typeof candidate.pattern === 'string'
            ? candidate.pattern === request.path
            : candidate.pattern.test(request.path)),
      );
      if (!route) {
        return this.json({ error: { status: 404, message: `No fake route for ${request.method} ${request.path}` } }, 404);
      }

      const result = route.handler(request);
      if (isFakeResponse(result)) {
        return this.json(result.body, result.status ?? 200, result.headers);
      }
      return this.json(result, 200);
    }) as typeof fetch;
  }

  public on(method: string, pattern: string | RegExp, handler: TFakeHandler): this;
  public on(method: string, pattern: string | RegExp, response: unknown): this;
  public on(method: string, pattern: string | RegExp, handler: unknown): this {
    this.routes.push({
      method,
      pattern,
      handler: typeof handler === 'function' ? (handler as TFakeHandler) : () => handler,
    });
    return this;
  }

  public get mutations(): IRecordedRequest[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  public requestsTo(method: string, path: string | RegExp): IRecordedRequest[] {
    return this.requests.filter(
      (request) =>
        request.method === method &&
        (typeof path === 'string' ? request.path === path : path.test(request.path)),
    );
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    if (status === 204 || body === undefined) {
      return new Response(null, { status: status === 200 ? 204 : status, headers });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
}

export function makeClient(fake: FakeSpotify, options: ISpotifyClientOptions = {}): SpotifyClient {
  return new SpotifyClient(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret-value',
      refreshToken: 'refresh-token-value',
      redirectUri: 'http://127.0.0.1:8888/callback',
    },
    { fetch: fake.fetch, sleep: async () => undefined, ...options },
  );
}

export interface IToolCallResult {
  isError: boolean;
  text: string;
  /** Parsed JSON body, or undefined when the text is not JSON. */
  json: any;
}

export class McpTestSession {
  public constructor(
    public readonly client: Client,
    public readonly server: McpServer,
  ) {}

  public async call(name: string, args: Record<string, unknown> = {}): Promise<IToolCallResult> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content.map((part) => part.text).join('\n');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: Boolean(result.isError), text, json };
  }

  public async toolNames(): Promise<string[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => tool.name).sort();
  }

  public async close(): Promise<void> {
    await this.client.close();
    await this.server.close();
  }
}

export async function startSession(
  fake: FakeSpotify,
  options: { disabledTools?: string[]; clientOptions?: ISpotifyClientOptions } = {},
): Promise<McpTestSession> {
  const server = createMcpServer(makeClient(fake, options.clientOptions), {
    disabledTools: options.disabledTools,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return new McpTestSession(client, server);
}

// ---- Fixtures --------------------------------------------------------------

export interface ITrackFixtureOptions {
  artists?: string[];
  album?: string;
  albumId?: string;
  releaseDate?: string;
  durationMs?: number;
  explicit?: boolean;
}

export function artistId(name: string): string {
  return `ar${name.replace(/\W/g, '')}`;
}

export function trackFixture(id: string, name = `Track ${id}`, options: ITrackFixtureOptions = {}) {
  const artists = options.artists ?? ['Artist One'];
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    duration_ms: options.durationMs ?? 180_000,
    explicit: options.explicit ?? false,
    type: 'track',
    artists: artists.map((artist) => ({
      id: artistId(artist),
      name: artist,
      uri: `spotify:artist:${artistId(artist)}`,
    })),
    album: {
      id: options.albumId ?? `al${id}`,
      name: options.album ?? `Album ${id}`,
      uri: `spotify:album:${options.albumId ?? `al${id}`}`,
      release_date: options.releaseDate ?? '2020-05-01',
    },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

export function itemFixture<TTrackLike>(track: TTrackLike, extra: Record<string, unknown> = {}) {
  return { added_at: '2024-01-01T00:00:00Z', item: track, ...extra };
}

/** Serves a list via limit/offset query parameters, like a Spotify paging endpoint. */
export function pagedRoute(all: unknown[]): TFakeHandler {
  return ({ query, path }) => {
    const limit = Number(query.get('limit') ?? 20);
    const offset = Number(query.get('offset') ?? 0);
    const items = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? `https://api.spotify.com/v1${path}?offset=${offset + limit}` : null;
    const page: ISpotifyPaging<unknown> = {
      href: '',
      items,
      limit,
      offset,
      next,
      previous: null,
      total: all.length,
    };
    return page;
  };
}

export function playlistFixture(id: string, name: string, ownerId = 'me-user', extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: '',
    public: false,
    collaborative: false,
    snapshot_id: `snap-${id}`,
    owner: { id: ownerId, display_name: ownerId },
    items: { total: 0 },
    external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
    ...extra,
  };
}
