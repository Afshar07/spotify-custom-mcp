import { z } from 'zod';
import { HistoryStore } from '../history/store.js';
import { errorResult, jsonResult, type IToolContext } from './shared.js';

export function registerHistoryTools({ registerTool }: IToolContext, history: HistoryStore): void {
  registerTool('get_history_status', { description: 'Read optional local Extended Streaming History import status and cutoff. No import is required to use Spotify Curator.', inputSchema: {} },
    async () => { try { return jsonResult(await history.status()); } catch (error) { return errorResult(error); } });
  registerTool('get_listening_profile', {
    description: 'Analyze imported local music history by listening duration, recorded starts, sustained plays (at least 30 seconds), skips and last play. Returns the export cutoff. No history means connected:false, not zero listening. Read-only.',
    inputSchema: { artist: z.string().max(200).optional(), since: z.string().max(40).optional(), until: z.string().max(40).optional(), limit: z.number().int().min(1).max(100).default(30) },
  }, async (query) => { try { return jsonResult(await history.profile(query)); } catch (error) { return errorResult(error); } });
  registerTool('check_tracks_in_history', {
    description: 'Check candidates against optional imported history by Spotify URI OR normalized title/artist, including remaster variants. recordedStarts:0 only means absent through the returned cutoff; supplement with available recent plays. Does not prove never heard.',
    inputSchema: { tracks: z.array(z.object({ uri: z.string().regex(/^spotify:track:[a-zA-Z0-9]+$/).optional(), name: z.string().min(1).max(500), artists: z.array(z.string().min(1).max(200)).min(1).max(20) })).min(1).max(100) },
  }, async ({ tracks }) => { try { return jsonResult(await history.checkTracks(tracks)); } catch (error) { return errorResult(error); } });
}
