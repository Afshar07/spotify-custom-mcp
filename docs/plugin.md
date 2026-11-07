# Spotify Curator plugin

The plugin bundles the local stdio MCP server with music curation, playlist
management, podcast discovery and onboarding skills. It is a local desktop
integration, not a hosted Spotify service.

## Upgrade an existing installation

Install the updated Windows package over the existing installation, open
**Spotify Curator Setup**, choose **Upgrade to plugin**, and restart Codex or
ChatGPT Desktop. The upgrade verifies the new server before switching the
desktop registration. No new Spotify developer app, copied tokens, Client
Secret or image-provider key is needed for migration.

Existing secure-store sign-in is reused. Legacy `env` and explicit `cwd/.env`
settings are read privately at runtime. Credentials inherited through legacy
`env_vars` are migrated automatically into a Windows DPAPI-protected local
file; manifests contain only its path. Start Setup from the existing
environment for that first migration if those variables are session-specific.
Private rollback data stays in the Curator data folder and may contain a
backup of existing configuration; it must not be committed or shared.

The upgrade merges the personal marketplace at
`~/.agents/plugins/marketplace.json`, registers resources under
`~/.codex/plugins/spotify-curator-local/<version>/`, enables
`spotify-curator@<existing-marketplace-name>`, and disables the matching old
desktop MCP entry after moving it to `spotify-curator-legacy`. The distinct
archive name keeps a disabled standalone entry from masking the plugin server;
its private connection settings remain available to the plugin at runtime.
OpenCode remains a standalone MCP client. Plugin files
launch the installed Curator executable by its bare name with the installation
folder prepended to the server's own `PATH`, so keep the app installed. Portable
Agent Plugins reject absolute executable commands. Verification uses this same
launch configuration; it does not change the user's system `PATH`.
The checked-in `plugins/spotify-curator` folder is a source
template; use Setup to produce installation-specific launch configuration.

**Undo upgrade** restores prior settings when that would not overwrite newer
edits. Retrying an unchanged upgrade preserves the original rollback point.
Interrupted transactions can be undone; locks from exited processes are
recovered automatically. The uninstaller removes plugin registration when
the user requests integration cleanup, preserving other plugins.

CLI equivalents: `spotify-curator.exe install-plugin` and
`spotify-curator.exe rollback-plugin`. These write local configuration; use
temporary `USERPROFILE`, `CODEX_HOME` and `SPOTIFY_CURATOR_DATA_DIR` values in
automated tests, never real user settings.

## Cover art

After creating a playlist, `create_playlist` and `generate_playlist` return a
pending cover workflow by default. The music skill generates creative square
art matching the playlist context using the host assistant's image tools,
excludes the user's name and identifying information, prepares a JPEG, and
calls `set_playlist_cover`. Set `coverArt:false` when the user opts out.

The MCP server does not contain an image model or require image-provider keys.
If host image generation/conversion is unavailable, the playlist remains
usable and its pending cover is reported honestly. Uploads are never claimed
from a dry run. Spotify's accepted response does not prove immediate image
propagation in every client.

Spotify requires `ugc-image-upload` in addition to playlist modification
permission. Existing sign-in continues working for ordinary Spotify calls
without this extra scope. **Enable cover uploads** uses the existing Client ID
and browser consent; it does not ask for a new developer app. Successful
browser consent saves the connection in the existing per-user secure store.

`set_playlist_cover` accepts exactly one absolute local JPEG path or base64
JPEG payload. It checks ownership and image structure, defaults to a read-only
preview, and caps the **encoded** payload at 256 KB. Spotify is the final image
decoder. Unknown upload outcomes are not automatically retried.

## Optional local history

In Setup, expand **Listening history (optional)**, choose your extracted Spotify
Extended Streaming History folder, and import. Importing is independent of
Spotify sign-in and is never required for ordinary curation.

The importer accepts audio `Streaming_History_Audio*.json` and older
`endsong*.json` exports. It retains only music names, artists, URIs, timestamps,
listening duration and skip flags in a per-user local index. It ignores IP
addresses, devices and other raw fields. No history is uploaded to GitHub or
Spotify by these tools. Query summaries sent to the assistant still become
part of that assistant interaction.

Exact duplicate normalized events are deduplicated; repeat plays at different
times remain. Malformed files fail without replacing a previous index.
Limits: 200 files, 100 MB per file, 1 GB total input, two million music events.
Podcasts and videos are not indexed in this first importer. **Refresh import**
re-reads the selected folder; **Remove imported history** removes the index,
leaving original export files untouched.

MCP tools: `get_history_status`, `get_listening_profile`, and
`check_tracks_in_history`. Queries report the export cutoff. Zero recorded
starts means absence from that import, not proof that a song was never heard;
the skill supplements this with Spotify's bounded recent history.

## Build and validation

`npm run build:exe` includes the plugin resources beside the executable in
`build/plugin`; the Windows installer ships both. `SPOTIFY_CURATOR_BUILD_DIR`
can select another project-local `build-<name>` folder when the ordinary build
is unavailable. `SPOTIFY_CURATOR_TEST_EXE` selects that executable for runtime
tests. Do not move the executable without its `plugin` resource folder.

Run both typechecks, the mocked test suite, the standalone build and runtime
tests. Desktop directory discovery, plugin cache refresh, restart behavior,
native folder picking and live Spotify cover consent require desktop/manual
acceptance; a successful MCP handshake alone does not verify those surfaces.

Packaging follows the [OpenAI plugin guide](https://developers.openai.com/plugins/build/plugins).
Image upload follows [Spotify's endpoint contract](https://developer.spotify.com/documentation/web-api/reference/upload-custom-playlist-cover).
