# OpenCode integration

This project is designed as a local stdio MCP server. Build it, then configure
OpenCode with the compiled entry point and project working directory:

```jsonc
{
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

`opencode.example.jsonc` is the maintained copyable template. The `cwd` makes
the project's `.env` available to `dotenv`; use absolute paths and do not put
credentials in the OpenCode config. Run `opencode mcp list` after configuration
to verify discovery.

The server process communicates MCP exclusively on stdin/stdout. Do not add
startup banners, debug `console.log`, or other stdout output to `src/server.ts`;
use stderr for diagnostics. For routine playlist work, direct agents to read
the playlist, search exact tracks, deduplicate URIs, then add the missing ones.
