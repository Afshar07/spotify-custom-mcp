# OpenCode integration

This project is designed as a local stdio MCP server. Build it, then configure
OpenCode with the compiled entry point and project working directory:

```jsonc
{
  "mcp": {
    "spotify-playlists": {
      "type": "local",
      "command": ["node", "/absolute/path/spotify-custom-mcp/dist/server.js"],
      "enabled": true
    }
  }
}
```

The shape is `mcp.<name>` with `type`, `command` (array), optional `environment`,
`enabled`, `timeout` (per OpenCode's MCP docs, read via search summaries). The earlier
`mcp.servers` + `codemode` template in this repo did not match it and was replaced.
One docs version mentions `cwd`; it is not relied on.

**End users:** `OpenCodeAdapter` (`src/clients/opencode-adapter.ts`) writes
`"spotify-curator": { type: "local", command: [<exe>, "mcp"], enabled: true }` into the
global config (`<XDG_CONFIG_HOME or ~/.config>/opencode/opencode.jsonc|json`). **Unverified
on real Windows:** that this is the file OpenCode reads there (OpenCode docs list
`~/.config/opencode/`; on Windows `~` is assumed to be `%USERPROFILE%`). Edits use
`jsonc-parser` (comments kept), back up to `%LOCALAPPDATA%\SpotifyCurator\backups`, re-validate
after writing and roll back on failure; conflicting Spotify entries are disabled, never deleted.

`opencode.example.jsonc` is the maintained copyable template. For a source checkout run OpenCode from the project folder so `.env` is found by
`dotenv`; use absolute paths and never put credentials in the OpenCode config. Run `opencode mcp list` after configuration
to verify discovery.

The server process communicates MCP exclusively on stdin/stdout. Do not add
startup banners, debug `console.log`, or other stdout output anywhere in `src/` (except `src/authorize.ts`);
use stderr for diagnostics. For routine playlist work, direct agents to read the playlist summary, search exact tracks, then use `add_unique_playlist_items` so duplicate prevention is enforced by the MCP tool. For new playlists, prefer `generate_playlist` (dry run first). After scope changes users must reconnect Spotify in Setup (or re-run `npm run auth` for env installs); `SPOTIFY_DISABLED_TOOLS` can hide tools.
