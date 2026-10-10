/**
 * OAuth scopes requested by `npm run auth`, with the features that need them.
 * Keep this list to the minimum the enabled tools require.
 */
export const SCOPE_PLAYLIST_MODIFY_PUBLIC = 'playlist-modify-public';
export const SCOPE_PLAYLIST_MODIFY_PRIVATE = 'playlist-modify-private';
export const SCOPE_PLAYLIST_READ_PRIVATE = 'playlist-read-private';
export const SCOPE_PLAYLIST_READ_COLLABORATIVE = 'playlist-read-collaborative';
export const SCOPE_LIBRARY_READ = 'user-library-read';
export const SCOPE_LIBRARY_MODIFY = 'user-library-modify';
export const SCOPE_TOP_READ = 'user-top-read';
export const SCOPE_RECENTLY_PLAYED = 'user-read-recently-played';

export const REQUESTED_SCOPES: readonly string[] = [
  SCOPE_PLAYLIST_MODIFY_PUBLIC,
  SCOPE_PLAYLIST_MODIFY_PRIVATE,
  SCOPE_PLAYLIST_READ_PRIVATE,
  SCOPE_PLAYLIST_READ_COLLABORATIVE,
  SCOPE_LIBRARY_READ,
  SCOPE_LIBRARY_MODIFY,
  SCOPE_TOP_READ,
  SCOPE_RECENTLY_PLAYED,
];
