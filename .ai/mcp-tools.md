# MCP tools and safe changes

`src/server.ts` owns MCP registration, Zod input schemas, tool descriptions,
and MCP result formatting. `src/spotify.ts` owns the corresponding Spotify Web
API request and response handling.

## Current tools

| Tool | Behavior and safety |
| --- | --- |
| `search_tracks` | Searches tracks (1–10) and returns exact Spotify URIs with compact metadata. |
| `get_playlist_items` | Reads one page or all pages of a playlist. Use `all=true` before additions when duplicate detection matters. |
| `get_playlist_summary` | Reads compact track summaries plus the current playlist snapshot ID for planning and concurrency checks. |
| `add_playlist_items` | Adds 1–100 validated Spotify track or episode URIs, optionally at a position. It does not deduplicate. |
| `add_unique_playlist_items` | Preferred addition workflow: validates Spotify track/episode URIs, reads the playlist, validates an optional expected snapshot, deduplicates, then adds only missing URIs. |
| `remove_playlist_items` | Removes 1–100 URIs. Optional `snapshotId` guards against stale playlist state. Destructive. |
| `reorder_playlist_items` | Moves a contiguous position range. Optional `snapshotId` guards against stale playlist state. Destructive in effect. |
| `replace_playlist_items` | Replaces the whole playlist with 0–100 URIs; omitted existing items are removed. Explicitly destructive. |
| `add_liked_tracks` | For 1–40 **track** URIs, checks Liked Songs first and saves only missing tracks. |

All playlist mutation tools accept an optional `expectedSnapshotId`. When supplied,
the server reads the current snapshot before mutation and rejects a mismatch without
making changes. `get_playlist_summary` exposes a current snapshot ID for this flow.
The Spotify endpoint snapshot supplied as `snapshotId` remains available on remove
and reorder for backwards compatibility.

## Mutation workflow

For ordinary additions, use `add_unique_playlist_items`. It reads the whole
playlist, compares exact URIs, and reports additions and duplicates. Re-read when a
decision is sensitive to current ordering or contents: other clients can change a
playlist between calls.

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

Do not silently change low-level tool semantics, retry a non-idempotent mutation
after an unknown network outcome, or infer a requested track from a display
name. Deduplication is intentional only in `add_unique_playlist_items`, whose
contract explicitly reports both added and skipped duplicate URIs. Such choices
must remain visible in tool behavior because they can alter playlist state.
