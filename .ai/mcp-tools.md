# MCP tools and safe changes

`src/mcp-server.ts` registers tool modules from `src/tools/`. Each handler owns
its Zod input schema, description and result formatting; Spotify HTTP lives in
`src/spotify.ts`; reusable logic lives in `src/services/`.

## Original tools (`src/tools/legacy.ts`) — stable contracts

| Tool | Behavior and safety |
| --- | --- |
| `search_tracks` | Searches tracks (1–10) and returns exact Spotify URIs with compact metadata. |
| `get_playlist_items` | Reads one page or all pages of a playlist. Use `all=true` before additions when duplicate detection matters. |
| `get_playlist_summary` | Compact track summaries plus the current playlist snapshot ID. |
| `add_playlist_items` | Adds 1–100 validated track or episode URIs, optionally at a position. No deduplication. |
| `add_unique_playlist_items` | Preferred addition workflow: reads the playlist, validates an optional expected snapshot, deduplicates, adds only missing URIs. |
| `remove_playlist_items` | Removes 1–100 URIs (every occurrence). Optional `snapshotId`. Destructive. |
| `reorder_playlist_items` | Moves a contiguous range. Optional `snapshotId`. Destructive in effect. |
| `replace_playlist_items` | Replaces the whole playlist with 0–100 URIs. Explicitly destructive. |
| `add_liked_tracks` | For 1–40 **track** URIs, checks Liked Songs first and saves only missing ones. |

All playlist mutation tools accept `expectedSnapshotId` (pre-write check;
mismatch aborts) and `dryRun` (default `false`).

## Added tools

| Module | Tool | Notes |
| --- | --- | --- |
| `playlists.ts` | `list_my_playlists` | `GET /me/playlists`; filters scan up to 500 playlists and return `nextOffset`. |
| | `create_playlist` | `POST /me/playlists` then batch add via `createPlaylistWithTracks`; same-name guard (`allowDuplicateName`); partial population is returned with `isError`. |
| | `update_playlist_details` | `PUT /playlists/{id}`; owner-only; sends only changed fields; `dryRun` diff. |
| `library.ts` | `get_top_items` | `GET /me/top/{tracks,artists}`; no popularity. |
| | `get_recently_played` | `after`/`before` are exclusive; limited history by Spotify. |
| | `get_liked_tracks` | Bounded by `maxItems` ≤ 500; `query` filters only retrieved items. |
| `discovery.ts` | `get_artist_albums` | `include_groups`, `market`; edition collapsing within the page. |
| | `get_album_tracks` | Paged album tracks. |
| `curation.ts` | `generate_playlist` | **`dryRun` defaults to true.** Verifies candidates with `GET /tracks/{id}` (400/404 ⇒ not found), exclusions, per-artist cap, `needs_more_candidates` guidance, creation via `createPlaylistWithTracks`. |
| | `analyze_playlist` | Read-only statistics (`services/playlist-analysis.ts`). |
| | `compare_playlists` | Read-only; Jaccard over unique track IDs (0 for empty/empty). |
| | `suggest_playlist_flow` | **`dryRun` defaults to true.** Subjective strategies need caller `scores` or `proposedOrder`; apply = optional snapshot-guarded removal (needs `confirmRemoval`) + sequential reorder moves (≤ 200), snapshot chained; partial failure returns `status: partial_failure`. |

## Podcast tools (`src/tools/podcasts.ts`)

Shows use bare IDs; episodes use `spotify:episode:` URIs. Episode and track
URI contracts are separate (`spotifyEpisodeUriSchema` vs `spotifyTrackUriSchema`).
Pure logic lives in `services/podcast-discovery.ts` (normalization, local
sort/filter); `services/podcast-library.ts` holds `saveEpisodes`.

| Tool | Notes |
| --- | --- |
| `search_podcasts`, `search_episodes` | `GET /search` type show/episode, limit 1–10, offset ≤ 1000; null results dropped and counted as `unavailable`. |
| `get_podcast_details` | `GET /shows/{id}`. |
| `get_podcast_episodes` | One page ≤ 50; `sort` reorders only that page; `includeShow` controls the extra show request. Never crawls the archive. |
| `get_saved_episodes`, `get_saved_podcasts` | `GET /me/episodes`, `GET /me/shows` via `collectPages`, `maxItems` ≤ 500, `query` filters retrieved items only. Need `user-library-read`. |
| `save_episode` | **`dryRun` defaults to true.** Reads `GET /me/library/contains` first, dedupes, writes `PUT /me/library` in batches of 40, never retries; a failed batch and later unattempted batches go to `failedUris` (`isError`). Needs `user-library-read` + `user-library-modify`. |

## Mutation workflow

For ordinary additions use `add_unique_playlist_items`. Re-read when a decision
depends on current ordering or contents. Use removal, reorder and especially
replacement only when the requested state is explicit. `replace_playlist_items`
with an empty list clears the playlist.

## Adding or changing a tool

1. Confirm the Spotify endpoint, scope, request limit, response shape and
   destructive/concurrency behavior against current Spotify docs (Development
   Mode) before implementation.
2. Add named interfaces in `src/models/` and the narrow client method in
   `src/spotify.ts` (declare required scopes via `scopes` so a missing scope
   fails before the request). Keep URI encoding and API errors in the client.
3. Put reusable logic in `src/services/` as pure functions where possible.
4. Register the tool in the matching `src/tools/*.ts` with a restrictive Zod
   schema, an operational description, and `try`/`catch` returning
   `errorResult`. Use `registerTool` from `IToolContext`.
5. Return compact, non-secret data. Identify destructive behavior in the
   description. Put limits in both the schema and the client assertion when
   mutation safety depends on them. A `dryRun` must not mutate.
6. Add unit tests (services) and integration tests (tool through the in-memory
   MCP client with `FakeSpotify`); never use live Spotify writes in tests.
7. Update `README.md`, this file and the focused `.ai` documents; run
   `npm run typecheck`, `npm run typecheck:tests`, `npm test`, `npm run build`.

Do not silently change low-level tool semantics, retry a non-idempotent
mutation after an unknown outcome, or infer a track from a display name.
