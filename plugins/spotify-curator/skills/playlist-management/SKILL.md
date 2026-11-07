---
name: playlist-management
description: Inspect and edit existing Spotify playlists, including adding tracks, deduplicating, reordering, comparing playlists, and updating covers or metadata.
---

# Playlist management

Resolve the target playlist from a supplied URI/ID or current playlist search; distinguish same-name playlists by owner and returned ID. Read all contents before deduplicating or planning an order. Use actual Spotify metadata and validated URIs.

- Prefer `add_unique_playlist_items` for additions. Compare normalized artist/title variants too; different release URIs can refer to the same song.
- Read a current snapshot immediately before applying state-dependent changes. A mismatch means no changes were made: refresh and re-plan before retrying.
- Apply removal, clearing, replacement and visibility changes only within the user's stated scope. A request for more tracks does not authorize removing tracks or rebuilding the playlist.
- `suggest_playlist_flow` computes artist balance mechanically. Subjective energy arcs require your explicit scores or a complete proposed order; do not fabricate audio features, tempo, key, popularity or related-artist metrics.
- An unknown write outcome is not permission to retry. Re-read to reconcile the actual state before another mutation. Preserve returned partial-success details.
- Respect preview-only requests. A direct request to perform an edit authorizes the scoped edit; do not require repetitive confirmations for dry-run previews.
- Re-read after changes, verify the requested result, and link the Spotify URL returned by the service. Do not claim a playlist was saved or a cover uploaded from a preview result.

For a newly created playlist, follow the default contextual cover workflow in [music-curation](../music-curation/SKILL.md). Updating an existing playlist does not automatically replace its artwork. For an explicitly requested cover change, generate a context-specific image using host image tools, exclude the user's name and identifying details, prepare a JPEG under Spotify's encoded-payload limit, and call `set_playlist_cover`.
