---
name: podcast-discovery
description: Discover Spotify podcasts and episodes matching a user's interests and listening style, and manage explicitly requested episode saves.
---

# Podcast discovery

Use podcast tools, not music-track search, for shows and episodes. Match the user's preferred format, pacing, tone, language and conversational style as well as subject. Explain why each suggestion fits; shared topic alone is weak evidence.

Search concrete shows/episodes and inspect descriptions or episode details before recommending. Saved shows and episodes demonstrate interest, not completed listening. The optional local history importer currently indexes music only; do not present it as podcast listening evidence.

`get_podcast_episodes` sorts only the fetched page; `get_saved_podcasts` and `get_saved_episodes` are bounded and filter retrieved items only. State material retrieval limits. Do not treat an empty bounded result as proof of absence from the user's entire library.

Save episodes only when requested, using validated `spotify:episode:` URIs with `save_episode`. Its preview is read-only; explicit save instructions authorize applying the scoped change. Inspect `failedUris` and report partial failures honestly. Verify available saved state afterward. If following shows is requested but no follow tool exists, say so and provide returned Spotify links; episode saving does not follow a show.
