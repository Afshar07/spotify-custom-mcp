# Spotify integration

## Responsibility split

`src/config.ts` loads environment configuration. `src/scopes.ts` defines the
OAuth scopes. `src/authorize.ts` performs the one-time authorization-code
bootstrap. `src/spotify.ts` holds the in-memory token cache and makes all
Spotify Web API calls: endpoint details, URI encoding, status handling,
retries, scope checks and batch assertions stay there.

## Authentication flow

`npm run auth` starts a temporary callback server at `SPOTIFY_REDIRECT_URI`
(host must be `127.0.0.1`), creates a random state, requests `REQUESTED_SCOPES`,
exchanges the code, and prints the refresh token for `.env`.

Scopes: `playlist-modify-public`, `playlist-modify-private`,
`playlist-read-private`, `playlist-read-collaborative`, `user-library-read`,
`user-library-modify`, `user-top-read`, `user-read-recently-played`. Changing
this list requires users to re-run `npm run auth`.

For MCP calls `SpotifyClient` refreshes an access token on demand, caches it
until 30 s before expiry, and records the `scope` string Spotify returns. A
request that declares `scopes: { allOf | anyOf }` fails with `SpotifyScopeError`
(before sending) when a scope is known to be missing. The original nine tools
declare no scopes, to stay compatible with older refresh tokens.

## Request handling

- Timeout 15 s per request (`AbortSignal.timeout`).
- 401: clear token, refresh and retry once.
- 429: wait `Retry-After` (min 1 s) and retry up to 3 times; stop with a
  `SpotifyApiError(429)` if the wait exceeds 30 s. Retrying 429 is safe for
  mutations because the request was not applied.
- 5xx and network errors/timeouts: GET is retried up to 2 times. Mutations are
  never retried; the error states the outcome is unknown.
- 403 messages mention missing scope or Development Mode access.
- Do not log token-bearing requests or Spotify response bodies.

## Endpoints used (Development Mode, February 2026 API)

`GET /search` (limit ≤ 10), `GET /tracks/{id}`, `GET /me`, `GET /me/playlists`,
`POST /me/playlists`, `GET|PUT /playlists/{id}` (metadata/update),
`GET|POST|PUT|DELETE /playlists/{id}/items`, `GET /me/top/{tracks|artists}`,
`GET /me/player/recently-played`, `GET /me/tracks`,
`GET /me/library/contains`, `PUT /me/library`, `GET /artists/{id}/albums`,
`GET /albums/{id}/tracks`.

Not used: `POST /users/{id}/playlists`, `/playlists/{id}/tracks`, batch
`GET /tracks|artists|albums`, Recommendations, Audio Features/Analysis,
Related Artists, browse endpoints.

## API behavior that matters

- Playlist reads accept 1–100 per page; `all=true` pages via `collectPages`
  (bounded at 11,000 items). Other lists use ≤ 50 per page.
- Playlist objects use `items` (not `tracks`) for the count reference and each
  playlist item uses `item` (legacy `track` is tolerated). Items can be `null`
  (removed/unavailable), local files or episodes; normalization reports them.
- In Development Mode, playlist contents are readable only for playlists the
  user owns or collaborates on; others return metadata only (403 on `/items`).
- The app owner needs Premium; new Development Mode apps have a small authorized
  user cap. Existing apps were granted a postponement of some changes, so do
  not assume identical behavior.
- Track `popularity` / `available_markets` and artist `followers` / `popularity`
  are not returned; never depend on them.
- Playlist add, remove, replace are capped at 100 URIs per request; Liked Songs
  calls at 40. Snapshots: `expectedSnapshotId` is a pre-write read check;
  remove and reorder also pass `snapshot_id` to Spotify's native guard.
- `recently-played`: `after` and `before` are mutually exclusive Unix-ms cursors
  and Spotify exposes only a short history.

## Error and state safety

Spotify errors become `Error` messages (`SpotifyApiError` carries `status`).
Low-level mutations do not prevent duplicates, and a successful snapshot does
not prove a prior read is still current. Preserve snapshot checks when a
decision depends on current playlist state.
