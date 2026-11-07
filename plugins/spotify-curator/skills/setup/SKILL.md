---
name: setup
description: Set up or migrate Spotify Curator to its local plugin, reuse an existing Spotify connection, and optionally connect an Extended Streaming History folder.
---

# Spotify Curator setup

For an existing installation, open Spotify Curator Setup and choose **Upgrade to plugin**. Reuse the installed executable and existing per-user secure store. Do not ask for new API keys, a new developer app, copied tokens or image-provider credentials. Restart the desktop app after migration so plugin skills and MCP configuration load.

The migration tests server startup, merges the personal plugin marketplace, enables the plugin and disables the matching old standalone MCP registration. It preserves private legacy environment settings in their existing configuration; never copy secret values into plugin manifests, chat or repository files. OpenCode's independent registration remains usable.

If cover permission is missing, use **Enable cover uploads** / Connect Spotify for a browser consent flow with the existing Client ID. Ordinary playlist functions must remain usable with an existing sign-in lacking the optional cover scope. Do not disconnect the user simply to request an extra permission.

History is optional: choose the extracted Spotify Extended Streaming History folder in Setup, import, and report its cutoff. Refresh after updating the folder; removing imported history removes the local index, not source exports or Spotify data. Exports and indexes belong outside the repository and are never uploaded to GitHub automatically.

For a fresh installation only, follow the existing setup wizard's Spotify developer-app and browser sign-in steps. If an existing connection cannot be reused, diagnose its configuration rather than prompting for a new app immediately. Distinguish a verified MCP handshake from actual desktop plugin loading; migration cannot prove the desktop has reloaded before restart.
