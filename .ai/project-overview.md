# Project overview

## Purpose and boundary

`spotify-custom-mcp` is a small private Node.js/TypeScript MCP server for
OpenCode. It reads and mutates existing Spotify playlists and adds missing
tracks to the current user's Liked Songs through Spotify's Web API.

It is not a Spotify client application, database-backed service, scheduler,
or multi-user/public SaaS. Keep dependencies, layers, and abstractions small;
reuse the existing server and `SpotifyClient` unless a boundary clearly earns
another component.

## Runtime flow

1. `src/server.ts` loads `.env` through `src/config.ts`, creates one
   `SpotifyClient`, registers MCP tools, and connects it to stdio.
2. An OpenCode tool call is validated by its Zod input schema, then delegates
   to `SpotifyClient` in `src/spotify.ts`.
3. The client obtains a cached access token by refreshing the configured
   refresh token, calls Spotify, and returns a result or a Spotify error.
4. The server serializes successful values as JSON text MCP content. It maps
   search and playlist tracks to compact summaries.

`src/authorize.ts` is a separate, interactive OAuth bootstrap program; it is
not part of the MCP stdio process.

## Preserve these invariants

- Never expose Spotify client credentials, access tokens, refresh tokens, or
  authorization codes in MCP outputs or logs. The one refresh-token rotation
  notice deliberately goes only to stderr and does not print its value.
- MCP server stdout is protocol-only. Send any server diagnostics to stderr.
  The standalone authorization program may print its user-facing bootstrap
  instructions to stdout.
- Playlist mutations operate on validated Spotify track or episode URIs returned by Spotify search or a prior playlist read. Do not infer IDs from names or URLs. Liked Songs accepts track URIs only.
- Read before changing when duplicates, positions, or current contents matter.
  Playlist state may change between that read and the later write.
- Prefer the safe high-level `add_unique_playlist_items` workflow for ordinary additions; it reads current playlist state and reports duplicate URIs. Use remove, reorder, or replacement only when the requested state is explicit.
- Respect request batch limits: at most 100 playlist URIs and at most 40
  Liked Songs URIs per call.

## Environment and commands

Required MCP environment values are `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN`. `SPOTIFY_REDIRECT_URI`
defaults to `http://127.0.0.1:8888/callback`. Keep `.env` local and untracked;
`.env.example` contains names only.

| Command | Purpose |
| --- | --- |
| `npm install` | install dependencies |
| `npm run auth` | run local OAuth bootstrap and print a refresh token to save in `.env` |
| `npm run dev` | run the server from TypeScript |
| `npm run typecheck` | strict TypeScript check without output |
| `npm run build` | compile `src` to `dist` |
| `npm start` | run compiled `dist/server.js` |

## Conventions and limitations

- Use named, explicit TypeScript interfaces with the `I...` prefix; avoid
  inline object types when a named interface is appropriate.
- This project uses native `fetch`, `@modelcontextprotocol/sdk`, Zod, and no
  test suite or database. Keep changes compatible with NodeNext ESM and
  strict TypeScript.
- The server exposes only the operations in `mcp-tools.md`; it does not create
  playlists, inspect general account data, or resolve ambiguous track choices.
- Token refresh is in-memory per server process. A rotated Spotify refresh
  token is reported to stderr but is not persisted automatically.

## Decisions not to casually change

- Keep MCP transport on stdio for local OpenCode use.
- Keep credentials in environment variables rather than adding persistence.
- Keep mutation controls at the MCP/Zod and Spotify-client boundaries.
- Do not turn the client into a generic Spotify SDK or introduce a data layer
  without a concrete feature that needs one.

Likely future work should be driven by a concrete safe workflow, such as
additional read-only discovery tools, clearer mutation confirmations, or
batch orchestration that preserves Spotify limits and snapshot behavior.
