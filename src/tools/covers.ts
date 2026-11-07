import { z } from 'zod';
import { MAX_COVER_PAYLOAD, readCoverJpeg, validateCoverJpeg } from '../services/playlist-cover.js';
import { spotifyIdSchema } from '../utils/uri.js';
import { errorResult, jsonResult, type IToolContext } from './shared.js';

export function registerCoverTools({ registerTool, spotify }: IToolContext): void {
  registerTool('set_playlist_cover', {
    description: 'Upload generated cover art to a playlist you own. Provide exactly one local JPEG imagePath or jpegBase64. Encoded payload max 256 KB. dryRun defaults true and validates without uploading. For new playlists generate creative art matching their context by default, never including the user name. Missing ugc-image-upload permission requires Spotify browser consent, not new API keys.',
    inputSchema: { playlistId: spotifyIdSchema, imagePath: z.string().min(1).max(4096).optional(), jpegBase64: z.string().min(1).max(MAX_COVER_PAYLOAD).optional(), dryRun: z.boolean().default(true) },
  }, async ({ playlistId, imagePath, jpegBase64, dryRun }) => {
    try {
      if ((imagePath === undefined) === (jpegBase64 === undefined)) throw new Error('Provide exactly one of imagePath or jpegBase64.');
      const image = imagePath !== undefined ? await readCoverJpeg(imagePath) : jpegBase64!;
      validateCoverJpeg(image);
      const [playlist, me] = await Promise.all([spotify.getPlaylist(playlistId), spotify.getCurrentUser()]);
      if (playlist.owner?.id !== me.id) throw new Error('Only the playlist owner can set its cover.');
      if (!dryRun) await spotify.uploadPlaylistCover(playlistId, image);
      return jsonResult({ playlistId, dryRun, status: dryRun ? 'validated' : 'accepted', encodedBytes: image.length });
    } catch (error) { return errorResult(error); }
  });
}
