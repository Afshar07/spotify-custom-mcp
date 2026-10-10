# OpenCode integration

This project is designed as a local stdio MCP server. Build it, then configure
OpenCode with the compiled entry point and project working directory:

```jsonc
{
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

`opencode.example.jsonc` is the maintained copyable template. The `cwd` makes
the project's `.env` available to `dotenv`; use absolute paths and do not put
credentials in the OpenCode config. Run `opencode mcp list` after configuration
to verify discovery.

The server process communicates MCP exclusively on stdin/stdout. Do not add
startup banners, debug `console.log`, or other stdout output anywhere in `src/` (except `src/authorize.ts`);
use stderr for diagnostics. For routine playlist work, direct agents to read the playlist summary, search exact tracks, then use `add_unique_playlist_items` so duplicate prevention is enforced by the MCP tool. For new playlists, prefer `generate_playlist` (dry run first). After scope changes users must re-run `npm run auth`; `SPOTIFY_DISABLED_TOOLS` can hide tools.
