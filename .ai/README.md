<!-- toolkit:sha256=790c87a74c2508498965eabbaf418bc8769d80e40abb44cce8821f0a85e00c2a -->
# .ai/ - Project Context for AI Agents

At workspace-router step 3, select one route below; defer its documents until
step 7, then follow the route exactly in order.

## Files

| File | Read when you're... |
| --- | --- |
| `project-overview.md` | changing any project behavior or needing the architecture, setup, and invariants |
| `mcp-tools.md` | adding or changing an MCP tool, its schema, output, or safety behavior |
| `spotify-integration.md` | changing Spotify requests, OAuth, token handling, paging, or playlist mutations |
| `opencode-integration.md` | changing local OpenCode MCP setup or runtime behavior |
| `ongoing/README.md` | continuing an in-progress task; read only the matching task document |

## Rules

- This folder is the local source of truth for AI task context in `spotify-playlist-mcp`.
- Keep file descriptions and task routes updated when project-specific decisions or boundaries change.
- Read only the files selected by the applicable task route or an exact user-named file.

## Task routes

- Continuing in-progress work: `ongoing/README.md` → only the matching task document → source.
- General implementation: `project-overview.md` → source.
- MCP tool or response change: `project-overview.md` → `mcp-tools.md` → `spotify-integration.md` → `src/server.ts` → `src/spotify.ts`.
- Spotify API, authentication, or mutation change: `project-overview.md` → `spotify-integration.md` → `src/config.ts` / `src/authorize.ts` / `src/spotify.ts`.
- OpenCode setup change: `project-overview.md` → `opencode-integration.md` → `opencode.example.jsonc` → `README.md`.
- Route format: `local-context.md` → optional domain context → source. Inspect an exact user-named source file first.
