# Spotify integration

## Responsibility split

`src/config.ts` loads and validates environment configuration.
`src/authorize.ts` performs the one-time authorization-code bootstrap.
`src/spotify.ts` holds the in-memory access-token cache and makes all Spotify
Web API calls. Keep Spotify endpoint details, URI encoding, status handling,
and batch assertions there.

## Authentication flow

`npm run auth` starts a temporary HTTP callback server at the configured
`SPOTIFY_REDIRECT_URI`, which must use host `127.0.0.1` rather than
`localhost`. It creates a random OAuth state, requests playlist modification
and Liked Songs read/write scopes, exchanges the returned code, and prints the
refresh token for the developer to save in `.env`.

For normal MCP calls, `SpotifyClient` exchanges the configured refresh token
for an access token on demand and caches it until 30 seconds before expiry. A
401 clears that cache; the failing request is still reported as an error.
Spotify rate-limit (429) responses wait for `Retry-After` (at least one second)
and retry the same request. Do not log token-bearing requests or responses.

## API behavior that matters

- Playlist reads accept a 1–100 page size. `all=true` follows Spotify paging
  from the supplied offset and returns collected items as one result.
- Playlist add, remove, and replace calls are capped at 100 URIs per request
  by this server. Split larger intentional operations explicitly.
- Liked Songs contains/save calls are capped at 40 URIs per request. The
  current tool permits only `spotify:track:` URIs and avoids saving tracks
  already present.
- Playlist endpoints return a `snapshot_id` after mutations. The client can read a
  playlist's current snapshot before any mutation when an `expectedSnapshotId` is
  supplied; a mismatch aborts before the write. Remove and reorder also pass that
  snapshot to Spotify's native request guard. Add and replace do not accept a
  snapshot in this implementation, so their protection is the pre-write check.
- Search is track-only and caps results at 10. Playlist add/replace schemas
  allow Spotify track or episode URIs, but callers must provide exact Spotify
  URIs.

## Error and state safety

Spotify errors are converted to `Error` messages and returned through the MCP
tool error result. Avoid adding logs that include Spotify response bodies
without confirming that they cannot include secrets.

A successful mutation returns only a snapshot ID. It does not prove a prior
read is still current, prevent duplicates, or make a retry safe. Preserve the
read-before-write workflow and use snapshots where the current API supports
them.
