# ChatGPT Desktop integration

Local desktop MCP configuration is supported. OpenAI documents STDIO servers,
Settings → MCP servers, and the shared desktop/Codex host configuration in
[`~/.codex/config.toml`](https://learn.chatgpt.com/docs/extend/mcp)
(verified against the official documentation on 2026-10-10).

This applies to local desktop chats using that host's MCP configuration.
Hosted ChatGPT web plugins are a separate integration: they use a remote
endpoint or Secure MCP Tunnel. This project continues to use local STDIO.

## Setup

1. Run `spotify-curator.exe setup` and connect Spotify.
2. Select **ChatGPT Desktop** and choose **Set up selected apps**.
3. Setup registers `spotify-curator.exe mcp`, initializes the server over
   STDIO, and lists its tools. A failed check is shown as a failure.
4. Restart ChatGPT Desktop. In a local chat, type `/mcp` to check connected
   servers, then ask: “Search Spotify for Miles Davis.”

Alternatively, run:

```powershell
.\spotify-curator.exe install-chatgpt
```

If another Spotify server exists, installation aborts by default. Use
`--disable-conflicts` only if you want to switch those entries off; they are
preserved and can be re-enabled in ChatGPT's settings.

To configure manually, open **Settings → MCP servers → Add server**, choose
**STDIO**, and set the command to the absolute path to `spotify-curator.exe`
with `mcp` as its argument. Save and restart ChatGPT.

For development without the standalone executable, build with `npm run build`
and configure the absolute path to `node.exe` as the command, with the absolute
path to `dist/server.js` as its argument. Legacy `.env` installs require the
repository as the working directory; packaged installs use the secure store.
Use the setup wizard from the standalone executable for automatic registration.

## Settings and recovery

- Configuration lives in `%USERPROFILE%\.codex\config.toml`, or
  `%CODEX_HOME%\config.toml` when that environment variable is set. Desktop,
  Codex CLI and IDE clients on the same host share this entry.
- The adapter preserves unrelated settings, comments, and existing per-tool
  policies/timeouts. No Spotify credentials are added to this file.
- Existing settings are backed up under
  `%LOCALAPPDATA%\SpotifyCurator\backups\chatgpt-*.toml.bak` before changes.
  The latest ten ChatGPT backups are retained. These backups contain the full
  original configuration; keep them private like the original file.
- Invalid TOML is left untouched. Failed writes or validation restore the
  original file. Settings changed by another process before writing cause an
  abort; close settings editors while running setup.
- Run setup again to repair a stale/disabled entry, or select ChatGPT Desktop
  and use **Repair**. `status` reports registration; `doctor` additionally
  verifies startup and tool discovery.
- `cleanup --chatgpt` removes only the Curator entry and refuses removal if it
  now points at another command. Uninstaller data removal includes this entry.
  Previously disabled conflicting entries are not automatically re-enabled.

## Verification boundary

Automated checks cover TOML preservation, backup/rollback, conflicts, repair,
wizard registration, and STDIO startup/tool discovery. They do not establish
desktop UI invocation, desktop process lifecycle, or write-approval behavior.

Manual acceptance remains required on the target desktop app:

- [ ] Restart the app and see Curator in `/mcp`.
- [ ] Discover all enabled tools and run a read-only search.
- [ ] Confirm start/stop behavior and a write tool's approval prompt without
      applying an unwanted Spotify mutation.

If your installed ChatGPT version has no MCP servers setting, verify that it
supports the documented local desktop workflow. A hosted chat does not load
local desktop configuration. No private app APIs or invented config locations
are used by this integration.
