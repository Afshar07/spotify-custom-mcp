<!-- toolkit:sha256=ed57ec031b88cb82cbc685ef9c1e76d31395f414e4340af17b7f0ece46879956 -->
# spotify-playlist-mcp

## Scope

Private local utility that exposes selected Spotify Web API operations as MCP
tools for OpenCode. It has no database, web UI, multi-user service, or public
SaaS boundary.

## Ownership boundaries

- This project owns its implementation details and local conventions.
- Cross-project contracts belong in shared workspace context.
- Preserve Spotify playlist state and credential secrecy over convenience or
  additional abstraction.
