# Project overview

## Purpose and boundary

`spotify-custom-mcp` is a local-first Node.js/TypeScript MCP server (stdio) for
OpenCode and other MCP clients. It lets an AI assistant explore Spotify, read
listening history, create/update/analyze/compare playlists, and propose or
apply better track orders through Spotify's Web API in Development Mode.

It is not a Spotify client application, hosted service, database-backed
service, scheduler, or multi-user/public SaaS. There is no remote/HTTP
transport, no external LLM integration, and no ChatGPT-specific plugin. The
MCP client does the creative/taste reasoning; this server does deterministic
validation, bookkeeping and statistics. Keep dependencies and abstractions
small.

## Runtime flow

1. `src/server.ts` creates one `SpotifyClient` from `src/config.ts`, builds the
   server with `createMcpServer` (`src/mcp-server.ts`) and connects stdio.
   `SPOTIFY_DISABLED_TOOLS` (comma-separated) leaves tools unregistered.
2. A tool call is validated by its Zod schema in `src/tools/*`, then delegates
   to `SpotifyClient` (`src/spotify.ts`) directly or through pure/orchestrating
   modules in `src/services/*`.
3. The client refreshes/caches the access token, checks granted OAuth scopes,
   calls Spotify (timeouts, bounded 429/5xx handling) and returns a result or a
   Spotify error.
4. Tools return compact JSON text (`jsonResult`), or `errorResult` /
   `jsonErrorResult` (structured body with `isError`) on failure.

`src/authorize.ts` is a separate interactive OAuth bootstrap; it is not part of
the MCP stdio process. Requested scopes live in `src/scopes.ts`.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/server.ts` | stdio entry; no logic beyond wiring |
| `src/mcp-server.ts` | `createMcpServer(spotify, options)` registers all tool modules (also used by tests) |
| `src/spotify.ts` | all Spotify HTTP: auth, scopes, retries, paging params, endpoint methods; re-exports `src/models/spotify.ts` types |
| `src/scopes.ts` | scope constants and `REQUESTED_SCOPES` |
| `src/models/` | `spotify.ts` API shapes, `curation.ts` normalized/analysis/flow/generation types and enums, `playlist.ts` tool-level results |
| `src/tools/` | MCP handlers: `legacy.ts` (original nine), `playlists.ts`, `library.ts`, `discovery.ts`, `curation.ts`, `shared.ts` |
| `src/services/` | `playlist-items.ts` (normalization), `playlist-analysis.ts`, `playlist-comparison.ts`, `playlist-flow.ts`, `playlist-generation.ts`, `playlist-creation.ts`, `playlist-listing.ts` |
| `src/utils/` | `uri.ts` (URI/ID schemas, dedupe, chunk), `pagination.ts` (`collectPages`) |
| `src/tools/podcasts.ts`, `src/services/podcast-*.ts`, `src/models/podcast.ts` | podcast tools (7), see `mcp-tools.md` |
| `tests/` | `unit/`, `integration/` (in-memory MCP client + fake Spotify HTTP), `helpers/fake-spotify.ts` |

## Preserve these invariants

- Never expose Spotify client credentials, access tokens, refresh tokens, or
  authorization codes in MCP outputs or logs. The one refresh-token rotation
  notice goes only to stderr and does not print its value.
- MCP server stdout is protocol-only. Send diagnostics to stderr. The
  standalone authorization program may print bootstrap instructions to stdout.
- Playlist mutations operate on validated Spotify track or episode URIs
  returned by Spotify search or a prior read. Do not infer IDs from names or
  URLs. Liked Songs accepts track URIs only.
- A `dryRun: true` call must never send a Spotify mutation request (reads are
  fine).
- Read before changing when duplicates, positions or current contents matter.
  Prefer `add_unique_playlist_items` for ordinary additions; use remove,
  reorder or replacement only when the requested state is explicit.
- Respect batch limits: at most 100 playlist URIs and 40 Liked Songs URIs per
  call; 50 per Spotify page (100 for playlist items); search max 10.
- Never silently retry a non-idempotent mutation after an unknown outcome;
  playlist creation is attempted once.
- Do not depend on removed/deprecated Spotify data: recommendations, audio
  features/analysis, related artists, track `popularity`, `available_markets`.
  Never fabricate such data; report a limitation instead.
- Original nine tool names, input contracts and output fields are a
  compatibility contract (covered by `tests/integration/regression-legacy-tools.test.ts`).

## Environment and commands

Required MCP environment values are `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN`. `SPOTIFY_REDIRECT_URI`
defaults to `http://127.0.0.1:8888/callback`. Optional:
`SPOTIFY_DISABLED_TOOLS`. Keep `.env` local and untracked; `.env.example`
contains names only.

| Command | Purpose |
| --- | --- |
| `npm install` | install dependencies |
| `npm run auth` | local OAuth bootstrap; prints a refresh token to save in `.env` (re-run when scopes change) |
| `npm run dev` | run the server from TypeScript |
| `npm run typecheck` / `typecheck:tests` | strict TypeScript check of `src` / of `src`+`tests` |
| `npm test` | Vitest: unit, integration and regression tests (mocked Spotify, no network) |
| `npm run build` | compile `src` to `dist` |
| `npm start` | run compiled `dist/server.js` |

## Conventions and limitations

- Named interfaces with the `I` prefix, enums with the `E` prefix, `T` for
  type aliases; avoid inline object types for reusable contracts. Keep changes
  compatible with NodeNext ESM and strict TypeScript.
- Stack: native `fetch`, `@modelcontextprotocol/sdk`, Zod; Vitest for tests. No
  database.
- Token refresh is in-memory per process. A rotated refresh token is reported
  to stderr but not persisted.
- Development Mode: playlist contents are only readable for playlists the user
  owns or collaborates on; the app owner needs Premium. See `spotify-integration.md`.

## Decisions not to casually change

- Keep MCP transport on stdio for local use.
- Keep credentials in environment variables rather than adding persistence.
- Keep mutation controls at the MCP/Zod and Spotify-client boundaries; keep
  Spotify HTTP inside `SpotifyClient` and business logic in `src/services`.
- Do not turn the client into a generic Spotify SDK, add a data layer, or add
  an LLM provider.
- Curation tools stay deterministic: subjective inputs (scores, orders,
  candidates) come from the caller.
