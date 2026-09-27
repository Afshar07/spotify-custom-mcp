# MCP tools and safe changes

`src/server.ts` owns MCP registration, Zod input schemas, tool descriptions,
and MCP result formatting. `src/spotify.ts` owns the corresponding Spotify Web
API request and response handling.

## Current tools

| Tool | Behavior and safety |
| --- | --- |
| `search_tracks` | Searches tracks (1–10) and returns exact Spotify URIs with compact metadata. |
| `get_playlist_items` | Reads one page or all pages of a playlist. Use `all=true` before additions when duplicate detection matters. |
| `add_playlist_items` | Adds 1–100 track or episode URIs, optionally at a position. It does not deduplicate. |
| `remove_playlist_items` | Removes 1–100 URIs. Optional `snapshotId` guards against stale playlist state. Destructive. |
| `reorder_playlist_items` | Moves a contiguous position range. Optional `snapshotId` guards against stale playlist state. Destructive in effect. |
| `replace_playlist_items` | Replaces the whole playlist with 0–100 URIs; omitted existing items are removed. Explicitly destructive. |
| `add_liked_tracks` | For 1–40 **track** URIs, checks Liked Songs first and saves only missing tracks. |

Snapshot IDs are returned by playlist mutation endpoints. The current read tool
does not expose a playlist snapshot ID, so a caller can only supply one it
already has; do not document snapshot-based concurrency as fully enforced.

## Mutation workflow

For ordinary additions, read the whole playlist, search Spotify for exact
tracks, compare URIs, then add only missing URIs. Re-read when a decision is
sensitive to current ordering or contents: other clients can change a playlist
between calls.

Use removal, reorder, and especially replacement only when the requested
state is explicit. `replace_playlist_items` with an empty URI list clears the
playlist. Never describe it as a safe way to append or edit one item.

## Adding or changing a tool

1. Confirm the Spotify endpoint, scope, request limit, response shape, and
   destructive/concurrency behavior before implementation.
2. Add explicit named interfaces in `src/spotify.ts` as needed and implement
   the narrow client method there. Keep URI encoding and API errors inside the
   client.
3. Register the tool in `src/server.ts` with a restrictive Zod schema,
   operational description, and `try`/`catch` returning `errorResult`.
4. Return only useful non-secret data. Summarize large Spotify objects rather
   than exposing raw responses without a reason.
5. Add limits in both the public schema and client assertion when mutation
   safety depends on them. Identify destructive behavior in the tool
   description.
6. Update `README.md`, this file, and focused `.ai` context together; run
   `npm run typecheck` and `npm run build`.

Do not silently deduplicate, retry a non-idempotent mutation after an unknown
network outcome, or infer a requested track from a display name. Such choices
can alter playlist state unexpectedly.
