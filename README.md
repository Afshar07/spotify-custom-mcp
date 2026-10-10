# Spotify Smart Playlist Curator (MCP)

A local, stdio [MCP](https://modelcontextprotocol.io) server that lets an AI assistant (OpenCode or any MCP client) explore Spotify, learn from your listening, create playlists, analyze and compare them, and propose better track orders.

- **Local-first.** You bring your own Spotify developer app. No hosted service, database, shared credentials or external AI provider.
- **The assistant decides taste; the server does the bookkeeping.** The server verifies tracks, removes duplicates, enforces limits, computes statistics and applies orders. It never "recommends" music itself, and it never invents audio features (energy, tempo, key) or popularity.
- **Safe by default.** Dry runs, snapshot checks, de-duplication and explicit confirmations guard every mutation.

> Status: unit and integration tests run against a mocked Spotify API. The server has **not** been exercised against live Spotify in automated tests (by design: tests never write to a real account). Do a manual smoke test with your own account (see [Verify your setup](#verify-your-setup)).

## Windows app (no terminal needed)

Install **Spotify Curator** with the Windows installer, then follow the setup wizard: enter your Spotify app's Client ID, connect Spotify in the browser (PKCE, no Client Secret), and set up **OpenCode** automatically. Your Spotify sign-in is stored encrypted for your Windows user only. See [docs/windows-distribution.md](docs/windows-distribution.md) for install steps, Spotify Development Mode limits, SmartScreen/signing notes and the release checklist.

- **ChatGPT Desktop:** automatic setup is **unverified** and not implemented; a labelled manual path is shown instead. Details: [docs/chatgpt-desktop.md](docs/chatgpt-desktop.md).
- Other MCP clients: use the copyable stdio config from the wizard (`spotify-curator.exe mcp`).
- Developers: `npm run build:exe` builds the standalone executable; `npm run setup` runs the wizard from source. The sections below describe the developer / environment-variable setup, which still works.

## Tools

### Playlists (original nine, unchanged)

| Tool | Purpose |
| --- | --- |
| `search_tracks` | Search tracks (1–10 results) and get exact Spotify URIs. |
| `get_playlist_items` | Read playlist items, one page or `all=true`. |
| `get_playlist_summary` | Compact tracks plus the current snapshot ID. |
| `add_playlist_items` | Add 1–100 URIs (no de-duplication). |
| `add_unique_playlist_items` | **Preferred** way to add: skips URIs already present or repeated in the request. |
| `remove_playlist_items` | Remove 1–100 URIs. Destructive. |
| `reorder_playlist_items` | Move a contiguous range. Destructive in effect. |
| `replace_playlist_items` | Replace the whole playlist (0–100 URIs). Explicitly destructive. |
| `add_liked_tracks` | Save up to 40 track URIs to Liked Songs, skipping ones already saved. |

All mutation tools accept `dryRun` and (except Liked Songs) `expectedSnapshotId`.

### Essential tools

| Tool | Purpose |
| --- | --- |
| `list_my_playlists` | Playlists you own or follow: ID, name, description, owner, visibility, item count, URL. Optional `nameFilter`, `ownedOnly`, paging (`nextOffset`). |
| `create_playlist` | Create a (private by default) playlist, optionally with up to 100 track URIs. `dryRun` previews. Refuses a duplicate name unless `allowDuplicateName`. Reports partial population honestly. |
| `update_playlist_details` | Change name, description or visibility of a playlist you own. `dryRun` shows a field diff. |
| `get_top_items` | Your top tracks or artists for `short_term` / `medium_term` / `long_term`. |

### Discovery and listening history

| Tool | Purpose |
| --- | --- |
| `get_recently_played` | Recent plays with timestamps and `after`/`before` cursors. Spotify exposes only a short recent history, not your full history. |
| `get_liked_tracks` | Saved tracks, bounded by `maxItems` (≤500), with an optional text filter over what was retrieved. |
| `get_artist_albums` | An artist's albums/singles, filterable by `includeGroups` and `market`; deluxe/remaster editions on the page are collapsed by default. |
| `get_album_tracks` | Track URIs, durations, track/disc numbers and explicit flags for an album. |

### Podcasts

Podcasts are separate from music: shows have `spotify:show:` IDs, episodes have `spotify:episode:` URIs, and episode tools never accept track URIs (or the reverse). Use `search_tracks` / `add_liked_tracks` for songs.

| Tool | Purpose |
| --- | --- |
| `search_podcasts` | Search shows (`GET /search?type=show`, ≤10 per call, `offset`, `market`). |
| `search_episodes` | Search episodes (`type=episode`); returns episode URIs, show, duration, release date, Spotify link. |
| `get_podcast_details` | One show's description, languages, episode count and link. |
| `get_podcast_episodes` | One bounded page (≤50) of a show's episodes. `sort=newest`/`oldest` reorders **only the returned page** (Spotify has no server-side sort); `includeShow=false` skips the show lookup on later pages. |
| `get_saved_episodes` | Saved episodes (`GET /me/episodes`), bounded by `maxItems` (≤500), with `savedAt` and an optional text filter over what was retrieved. Not listening history. |
| `get_saved_podcasts` | Saved/followed shows (`GET /me/shows`), bounded and filterable. |
| `save_episode` | Save 1–100 episode URIs (`PUT /me/library`, batches of 40). Reads first, skips already-saved and duplicate URIs. **`dryRun` defaults to `true`.** |

### Smart curation (deterministic, no LLM inside)

| Tool | Purpose |
| --- | --- |
| `generate_playlist` | Validate a candidate list the assistant chose: verify each URI exists, drop duplicates and excluded tracks/artists, cap tracks per artist, preview, then create. **`dryRun` defaults to `true`.** If candidates run short it returns `needs_more_candidates` guidance and creates nothing. |
| `analyze_playlist` | Totals, duplicates, duration, artist frequency and concentration, album and release-year distribution, explicit split, missing metadata, measurable suggestions. |
| `compare_playlists` | Shared / exclusive tracks, duplicate counts, artist overlap, durations, Jaccard similarity and merge candidates. Read-only. |
| `suggest_playlist_flow` | Propose (and optionally apply) a listening order. **`dryRun` defaults to `true`.** |

Similarity is `|A ∩ B| / |A ∪ B|` over unique Spotify track IDs, and is defined as `0` when both playlists have no comparable tracks. Local files, episodes and unavailable items have no track ID and are counted separately.

`suggest_playlist_flow` strategies:

| Strategy | Computed from | Needs from the assistant |
| --- | --- | --- |
| `balanced_artists` | artist metadata (round-robin by artist) | nothing |
| `minimize_repetition` | artist metadata (no back-to-back same artist where possible, close to the current order) | nothing |
| `gradual_build` | caller-supplied `scores` | `scores` (URI → number) **or** `proposedOrder` |
| `calm_start` | caller-supplied `scores` (lowest `edgeCount` first) | `scores` or `proposedOrder` |
| `strong_finish` | caller-supplied `scores` (highest `edgeCount` last) | `scores` or `proposedOrder` |
| `custom` | nothing | `proposedOrder` (a full ordering) |

Without the required input the tool returns `status: "needs_input"`; it never guesses energy, tempo or key.

## 1. Create a Spotify developer app

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Add this redirect URI exactly (not `localhost`): `http://127.0.0.1:8888/callback`
3. Copy the Client ID and Client Secret.

## Development Mode: what to expect

Apps start in Spotify's **Development Mode**, which this project treats as the supported environment. Per Spotify's current documentation (February 2026 changes):

- The **app owner needs an active Spotify Premium** subscription; if it lapses the app stops working.
- New Development Mode apps are limited to a small number of authorized users (5 at the time of writing). Apps that existed before the change keep their existing allowances, and Spotify postponed the endpoint changes for existing Development Mode apps, so older and newer apps may behave differently. Check the [changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) for the current state.
- **Playlist contents (`/playlists/{id}/items`) are only readable for playlists you own or collaborate on.** For other playlists Spotify returns metadata only, so `analyze_playlist`, `compare_playlists`, `suggest_playlist_flow` and `generate_playlist` with `seedPlaylistId` fail with a clear 403 for playlists you merely follow.
- `GET /search` returns at most **10** results (default 5).
- Track `popularity` and `available_markets`, and artist `followers`/`popularity`, are no longer returned. This server does not use them. Tracks are not checked for market availability; "verification" in `generate_playlist` means the track ID resolves.
- Spotify's Recommendations, Audio Features, Audio Analysis and Related Artists endpoints are not used.

## 2. Install and configure

```bash
npm install
cp .env.example .env
```

```dotenv
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
# Optional: SPOTIFY_DISABLED_TOOLS=get_top_items,get_recently_played
```

Never commit `.env`. The project ships no credentials.

## 3. Authorize your account

```bash
npm run auth
```

Open the printed URL, approve access, and copy the printed `SPOTIFY_REFRESH_TOKEN` into `.env`. **Re-run this whenever the scope list changes** (for example after upgrading from the first version); the server checks the granted scopes and tells you which one is missing instead of sending a doomed request.

| Scope | Used by |
| --- | --- |
| `playlist-modify-public`, `playlist-modify-private` | creating and changing playlists and their items |
| `playlist-read-private`, `playlist-read-collaborative` | `list_my_playlists`, reading private/collaborative playlist contents |
| `user-library-read`, `user-library-modify` | `get_liked_tracks`, `add_liked_tracks`, `get_saved_episodes`, `get_saved_podcasts`, `save_episode` |
| `user-top-read` | `get_top_items` |
| `user-read-recently-played` | `get_recently_played` |

No new scopes were added for podcasts, so existing refresh tokens that already include the library scopes keep working; run `npm run auth` again only if `user-library-read`/`user-library-modify` were never granted. `user-read-playback-position` is deliberately **not** requested (it only populates `resume_point`).

Don't want a feature? Set `SPOTIFY_DISABLED_TOOLS` to hide its tools. If a scope is simply not granted, only the tools that need it return a scope error; the rest keep working.

## 4. Build

```bash
npm run typecheck
npm run build
npm test
```

## 5. Configure your MCP client

### OpenCode

Merge the `spotify-playlists` entry from `opencode.example.jsonc` into your OpenCode config and replace the absolute paths:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "spotify-playlists": {
        "type": "local",
        "command": ["node", "/absolute/path/spotify-custom-mcp/dist/server.js"],
        "cwd": "/absolute/path/spotify-custom-mcp",
        "codemode": false
      }
    }
  }
}
```

Then run `opencode mcp list`.

### Any stdio MCP client

Run `node dist/server.js` with the project directory as working directory (so `.env` is found), or pass the variables in the client's `env` block:

```json
{
  "command": "node",
  "args": ["/absolute/path/spotify-custom-mcp/dist/server.js"],
  "env": {
    "SPOTIFY_CLIENT_ID": "...",
    "SPOTIFY_CLIENT_SECRET": "...",
    "SPOTIFY_REFRESH_TOKEN": "..."
  }
}
```

The server speaks MCP on stdout only; diagnostics go to stderr.

### Verify your setup

1. `list_my_playlists` (checks auth and `playlist-read-private`).
2. `create_playlist` with `dryRun: true`, then without it on a throwaway name.
3. `get_top_items`, `get_recently_played`, `get_liked_tracks` (checks the other scopes).

## 6. Examples

Prompts you can give your assistant; the tool names show what it will use.

**Create a playlist from natural-language preferences**

> Use spotify-playlists. Build a 25-track "late-night drive" playlist: dark synthwave and melodic electronic, no more than two tracks per artist, nothing by Artist X. Search for exact tracks, call `generate_playlist` as a dry run, show me the preview, and only create it after I approve.

The assistant uses `search_tracks` to collect URIs, `generate_playlist` (dry run) to validate and preview, then `generate_playlist` with `dryRun: false`.

**Build a playlist from your liked tracks**

> Look at my top artists for the last 6 months and my liked tracks matching "ambient", pick 30 that fit a focus playlist, and create it.

`get_top_items` → `get_liked_tracks` (with `query`) → `generate_playlist`.

**Find underrepresented artists**

> Analyze my playlist `<id>`. Which artists dominate? Then look through my top artists' catalogs and suggest 10 tracks from artists that are missing or rare in it.

`analyze_playlist` (artist frequency/concentration) → `get_top_items` → `get_artist_albums` → `get_album_tracks` → `add_unique_playlist_items` (dry run first).

**Compare two playlists**

> Compare playlists `<A>` and `<B>`. What do they share, and which tracks from B would round out A?

`compare_playlists` returns `similarity`, `shared`, `onlyInA`, `onlyInB` and `mergeCandidates.intoA`. It changes nothing; use `add_unique_playlist_items` to act on the candidates.

**Remove duplicate songs safely**

> Analyze playlist `<id>` for duplicates and remove the extra copies.

`analyze_playlist` lists `duplicates` with positions. Note that `remove_playlist_items` removes **every** occurrence of a URI, so the safe pattern is: `remove_playlist_items` for the duplicated URIs with `dryRun: true` and the snapshot from `get_playlist_summary` as `expectedSnapshotId`, then `add_unique_playlist_items` to put one copy back. Review the dry-run output with the assistant before each step.

**Suggest a better listening sequence**

> Suggest a better order for playlist `<id>` that avoids back-to-back tracks by the same artist. Show me before and after.

`suggest_playlist_flow` with `strategy: "minimize_repetition"` returns `originalOrder`, `proposedOrder` and objective metrics (adjacent same-artist pairs, longest run). Apply it with `dryRun: false` and the `expectedSnapshotId` from the preview.

For an energy build, have the assistant score each track (0–10) from its own knowledge and pass `scores` with `strategy: "gradual_build"`; the server only sorts by the scores you give it.

## Podcast workflows

**Discover technical podcasts** — "Find podcasts about AI coding agents, developer tooling and software architecture." → `search_podcasts` (one call per topic) → `get_podcast_episodes` for promising shows → recommend with the returned Spotify links.

**Find recent episodes** — "Find recent episodes about Vue and Nuxt." → `search_episodes` (+ `get_podcast_episodes` with `sort: "newest"`) → compare `releaseDate`. Search returns at most 10 results per call, so the assistant should say how many pages it covered rather than claim completeness or freshness.

**Curate a listening collection** — "Find 10 episodes about practical AI development and save them." → `search_episodes` → `save_episode` with `dryRun: true` (default) → show `newlySavedUris` / `alreadySavedUris` → only after you approve, call again with `dryRun: false`.

**Explore saved episodes** — "Look through my saved episodes for software architecture." → `get_saved_episodes` with `query` (and `nextOffset` to continue). The filter only sees retrieved items.

## Safety model

- **Dry runs never mutate.** `dryRun: true` performs reads only. `generate_playlist` and `suggest_playlist_flow` default to a dry run; the other mutation tools default to `false` to keep their original behavior.
- **Snapshots.** Pass `expectedSnapshotId` (from `get_playlist_summary` or a preview). A mismatch aborts before any write. Applying a flow carries the snapshot through each reorder call.
- **De-duplication.** `add_unique_playlist_items`, `create_playlist` and `generate_playlist` drop repeated URIs; `generate_playlist` also drops excluded tracks/artists.
- **Bounds.** At most 100 playlist URIs per mutation, 40 Liked Songs URIs, 50 items per Spotify page, 500 liked tracks per call. Applying a flow needs at most 200 reorder calls.
- **Destructive operations are explicit.** `remove_playlist_items`, `reorder_playlist_items`, `replace_playlist_items` and flow `excludeUris` (which also needs `confirmRemoval: true`) say so in their descriptions and results.
- **No blind retries.** Rate-limited (429) requests are retried after `Retry-After` (bounded). Reads are retried on 5xx/timeouts. A mutation that fails with a 5xx or a network error is **not** retried, and the error says the outcome is unknown so the assistant re-reads the playlist first. Playlist creation is attempted once.

## Spotify Mix

Spotify's Mix / Smart Reorder transitions are a proprietary feature of the Spotify app. This project does not use private endpoints, has no access to transition settings, and `suggest_playlist_flow` is independent of it. To use Mix, enable it manually in the Spotify app on a playlist.

## Rate limits

On HTTP 429 the client waits for `Retry-After` (minimum 1 s) and retries up to 3 times; if Spotify asks for more than 30 s it stops and reports the wait. Requests time out after 15 s.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `Missing Spotify OAuth scope(s): …` | Re-run `npm run auth` and update `SPOTIFY_REFRESH_TOKEN`. |
| `Spotify API 403` reading a playlist | You don't own/collaborate on it (Development Mode), or the scope is missing. |
| `Spotify API 403` on everything | Premium lapsed for the app owner, or your account isn't an authorized user of the app. |
| `Spotify token refresh failed` | Wrong client ID/secret, revoked grant, or an old refresh token; run `npm run auth` again. |
| `Rate limited by Spotify. Retry after N seconds.` | Wait, then retry. |
| `Playlist snapshot mismatch` | The playlist changed; re-read it and redo the plan. |
| `You already own N playlist(s) named …` | Use that playlist, rename, or pass `allowDuplicateName: true`. |
| A tool is missing | It is listed in `SPOTIFY_DISABLED_TOOLS`. |
| `Spotify returned a rotated refresh token` (stderr) | Put the new value in `.env`; it isn't saved automatically. |

## Known limitations

- Playlist contents of playlists you don't own or collaborate on are unavailable in Development Mode.
- No popularity, audio features, recommendations or related artists (not available or deprecated).
- Track availability by market can't be checked; `generate_playlist` verifies that each track ID exists.
- `get_artist_albums` collapses editions only within the returned page.
- `suggest_playlist_flow` can't apply an order to a playlist containing unavailable items without URIs (preview works), and refuses orders needing more than 200 reorder calls.
- Removing duplicates with `remove_playlist_items` removes every copy of a URI.
- Podcasts: Spotify deprecated show `publisher` and `available_markets`, so publisher is often missing; descriptions are truncated to 300 characters; episodes with `playable: false` are restricted in your market (pass `market`). Search is capped at 10 results per call and 1000 offset.
- Podcasts: `get_podcast_episodes` sorts only the returned page, `get_saved_episodes`/`get_saved_podcasts` are bounded to `maxItems`, and nothing downloads audio or transcripts (Spotify provides neither).
- Podcast endpoints were checked against Spotify's February 2026 changelog and mocked in tests; behavior against a real Development Mode account is unverified until the podcast smoke test is run.
- Refresh-token rotation is reported on stderr but not persisted.

## Podcast smoke test (real account, manual)

Automated tests never touch Spotify. After `npm run build`, ask your MCP client, in order:

1. "Search podcasts for 'software architecture'" — expect shows with links.
2. "List the 5 newest episodes of the first show" — expect `nextOffset` and release dates.
3. "Show my saved episodes" — a `403` means re-run `npm run auth`.
4. "Save `<episode URI>` to my library" — expect a dry-run preview; confirm, then repeat with `dryRun: false` and verify in the Spotify app. Re-running should report it under `alreadySavedUris`.

## Development

```bash
npm run dev            # run from TypeScript
npm run typecheck      # src
npm run typecheck:tests
npm test               # unit + integration + regression (mocked Spotify, no network)
npm run build
```

Layout: `src/server.ts` (stdio entry), `src/mcp-server.ts` (tool wiring), `src/spotify.ts` (HTTP client: auth, retries, scopes), `src/tools/*` (MCP handlers), `src/services/*` (pure business logic), `src/models/*` (interfaces and enums), `src/utils/*`, `tests/`.
