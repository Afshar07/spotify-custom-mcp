import type { ISaveEpisodesFailure, ISaveEpisodesResult } from '../models/podcast.js';
import type { SpotifyClient } from '../spotify.js';
import { chunk, dedupePreservingOrder, isEpisodeUri } from '../utils/uri.js';

/** Spotify's `/me/library` endpoints accept at most 40 URIs per request. */
export const LIBRARY_BATCH_SIZE = 40;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Saves episodes to the library only when missing. Reads first (always), so a dry run performs
 * no write. A failed write batch is never retried here; the batch and every batch after it are
 * reported as failed so the caller can re-read state before trying again.
 */
export async function saveEpisodes(
  spotify: Pick<SpotifyClient, 'checkLibraryContains' | 'saveToLibrary'>,
  episodeUris: string[],
  dryRun: boolean,
): Promise<ISaveEpisodesResult> {
  const invalid = episodeUris.filter((uri) => !isEpisodeUri(uri));
  if (invalid.length > 0) {
    throw new Error(`Not Spotify episode URIs (expected spotify:episode:<id>): ${invalid.join(', ')}`);
  }

  const { unique, duplicates } = dedupePreservingOrder(episodeUris);
  const batches = chunk(unique, LIBRARY_BATCH_SIZE);

  const alreadySavedUris: string[] = [];
  const missingUris: string[] = [];
  for (const batch of batches) {
    const saved = await spotify.checkLibraryContains(batch);
    batch.forEach((uri, index) => (saved[index] ? alreadySavedUris : missingUris).push(uri));
  }

  const result: ISaveEpisodesResult = {
    dryRun,
    requestedUris: episodeUris,
    duplicateInputUris: duplicates,
    alreadySavedUris,
    newlySavedUris: [],
    failedUris: [],
  };

  if (dryRun) {
    result.newlySavedUris = missingUris;
    return result;
  }

  const failed: ISaveEpisodesFailure[] = [];
  const writeBatches = chunk(missingUris, LIBRARY_BATCH_SIZE);
  for (const [index, batch] of writeBatches.entries()) {
    try {
      await spotify.saveToLibrary(batch);
      result.newlySavedUris.push(...batch);
    } catch (error) {
      const reason = reasonOf(error);
      failed.push(...batch.map((uri) => ({ uri, reason })));
      for (const skipped of writeBatches.slice(index + 1).flat()) {
        failed.push({ uri: skipped, reason: 'Not attempted because an earlier batch failed.' });
      }
      break;
    }
  }
  result.failedUris = failed;
  return result;
}
