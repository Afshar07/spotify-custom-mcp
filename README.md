# Spotify Playlist MCP

A tiny local MCP server for OpenCode that can read and modify existing Spotify playlists.

## Tools

- `search_tracks`
- `get_playlist_items`
- `add_playlist_items`
- `remove_playlist_items`
- `reorder_playlist_items`
- `replace_playlist_items`
- `add_liked_tracks`

The server uses Spotify's current `/playlists/{id}/items` endpoints.

## 1. Create a Spotify developer app

1. Open the Spotify Developer Dashboard and create an app.
2. Add this redirect URI exactly:

   `http://127.0.0.1:8888/callback`

   Do **not** use `localhost`.
3. Copy the Client ID and Client Secret.

## 2. Install and configure

```bash
npm install
cp .env.example .env
```

Put your credentials in `.env`:

```dotenv
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

Do not commit `.env`.

## 3. Authorize your Spotify account once

```bash
npm run auth
```

The script prints a Spotify authorization URL and starts a temporary callback server on `127.0.0.1:8888`.

Open the URL, approve the requested scopes, then copy the printed `SPOTIFY_REFRESH_TOKEN` into `.env`.
Re-run this step after updating if you previously authorized the app without the
Liked Songs scopes.

Requested scopes:

- `playlist-modify-public`
- `playlist-modify-private`
- `user-library-read`
- `user-library-modify`

## 4. Build

```bash
npm run typecheck
npm run build
```

## 5. Add it to OpenCode

Copy `opencode.example.jsonc` into your OpenCode config or merge the `spotify-playlists` server entry into your existing config. Replace `/ABSOLUTE/PATH/...` with the real path.

Current OpenCode V2 local MCP shape:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "spotify-playlists": {
        "type": "local",
        "command": ["node", "/absolute/path/spotify-playlist-mcp/dist/server.js"],
        "cwd": "/absolute/path/spotify-playlist-mcp",
        "codemode": false
      }
    }
  }
}
```

Then verify:

```bash
opencode mcp list
```

## 6. Example OpenCode prompt

```text
Use spotify-playlists.

Playlist ID: 21ozzAcXzU1nGhyikLky4M

Read the whole playlist first. Find 15 tracks matching a dark, melodic, emotional modern-rock taste with strong vocals, hooks, atmosphere and some aggression. Do not add anything already present in the playlist. Search Spotify for exact tracks, then add the unique selections to the end of the existing playlist. Show me what you added.
```

## Safety notes

`replace_playlist_items` is destructive: Spotify replaces the current playlist contents with the URIs supplied to it. The tool description tells the agent this explicitly.

For ordinary recommendations, prefer this sequence:

1. `get_playlist_items(all=true)`
2. `search_tracks`
3. deduplicate by Spotify URI
4. `add_playlist_items`

Spotify accepts a maximum of 100 playlist item mutations in one request.

## Development

Run directly without building:

```bash
npm run dev
```

For OpenCode, the compiled `dist/server.js` path is less fragile.
