import {
  EGenerationRejection,
  EGenerationStatus,
  EPlaylistItemKind,
  type IGenerationCandidate,
  type IGenerationPlan,
  type IGenerationPlanOptions,
  type IGenerationRejection,
  type INormalizedTrack,
} from '../models/curation.js';
import type {
  IGeneratePlaylistInput,
  IGeneratePlaylistResult,
  IMoreCandidatesGuidance,
  ITrackPreview,
} from '../models/playlist.js';
import { SpotifyApiError, type SpotifyClient } from '../spotify.js';
import { chunk, dedupePreservingOrder, idFromUri } from '../utils/uri.js';
import { createPlaylistWithTracks } from './playlist-creation.js';
import {
  normalizePlaylistItems,
  normalizeTrack,
  primaryArtistKey,
  trackKey,
} from './playlist-items.js';

export const GENERATION_LOOKUP_BATCH = 10;
export const GENERATION_MAX_REPORTED_REJECTIONS = 25;

const SUGGESTED_TOOLS = [
  'search_tracks',
  'get_top_items',
  'get_liked_tracks',
  'get_recently_played',
  'get_artist_albums + get_album_tracks',
];

function toPreview(track: INormalizedTrack): ITrackPreview {
  return { uri: track.uri, name: track.name, artists: track.artists.map((artist) => artist.name) };
}

/**
 * Pure selection: applies exclusions, de-duplication and the per-artist limit
 * to candidates in the order given, up to the target count.
 */
export function planGeneration(
  candidates: IGenerationCandidate[],
  options: IGenerationPlanOptions,
): IGenerationPlan {
  const excludedUris = new Set(options.excludeTrackUris);
  const excludedArtists = new Set(options.excludeArtists.map((value) => value.trim().toLowerCase()));
  const seen = new Set<string>();
  const selected: INormalizedTrack[] = [];
  const rejected: IGenerationRejection[] = [];
  const artistTotals = new Map<string, number>();
  const artistsAtLimit = new Map<string, string>();

  const reject = (track: INormalizedTrack, reason: EGenerationRejection): void => {
    rejected.push({ uri: track.uri, ...(track.name ? { name: track.name } : {}), reason });
  };

  for (const { track } of candidates) {
    const key = trackKey(track);
    const primary = primaryArtistKey(track);

    if (excludedUris.has(track.uri)) {
      reject(track, EGenerationRejection.ExcludedTrack);
    } else if (seen.has(key)) {
      reject(track, EGenerationRejection.Duplicate);
    } else if (
      track.artists.some(
        (artist) =>
          excludedArtists.has(artist.name.trim().toLowerCase()) ||
          (artist.id !== undefined && excludedArtists.has(artist.id.toLowerCase())),
      )
    ) {
      seen.add(key);
      reject(track, EGenerationRejection.ExcludedArtist);
    } else if (
      options.maxTracksPerArtist !== undefined &&
      primary !== undefined &&
      (artistTotals.get(primary) ?? 0) >= options.maxTracksPerArtist
    ) {
      seen.add(key);
      artistsAtLimit.set(primary, track.artists[0].name);
      reject(track, EGenerationRejection.ArtistLimit);
    } else if (selected.length >= options.targetTrackCount) {
      seen.add(key);
      reject(track, EGenerationRejection.OverTarget);
    } else {
      seen.add(key);
      selected.push(track);
      if (primary !== undefined) {
        artistTotals.set(primary, (artistTotals.get(primary) ?? 0) + 1);
      }
    }
  }

  const rejectedByReason: Partial<Record<EGenerationRejection, number>> = {};
  for (const entry of rejected) {
    rejectedByReason[entry.reason] = (rejectedByReason[entry.reason] ?? 0) + 1;
  }

  return {
    selected,
    rejected,
    rejectedByReason,
    shortfall: Math.max(options.targetTrackCount - selected.length, 0),
    artistsAtLimit: [...artistsAtLimit.values()],
  };
}

async function lookupTrack(spotify: SpotifyClient, uri: string): Promise<INormalizedTrack | null> {
  const id = idFromUri(uri);
  if (!id) {
    return null;
  }
  try {
    return normalizeTrack(await spotify.getTrack(id));
  } catch (error) {
    // 400/404 mean the ID does not resolve to a track; anything else is a real failure.
    if (error instanceof SpotifyApiError && (error.status === 404 || error.status === 400)) {
      return null;
    }
    throw error;
  }
}

/**
 * Turns caller-selected candidates into a validated playlist. The caller does
 * the taste reasoning; this only verifies, filters, de-duplicates and (when
 * `dryRun` is false) creates the playlist through the shared creation path.
 */
export async function generatePlaylist(
  spotify: SpotifyClient,
  input: IGeneratePlaylistInput,
): Promise<IGeneratePlaylistResult> {
  const warnings: string[] = [];
  const needsMetadata = input.excludeArtists.length > 0 || input.maxTracksPerArtist !== undefined;
  if (!input.verifyCandidates && needsMetadata) {
    throw new Error(
      'excludeArtists and maxTracksPerArtist need track metadata; set verifyCandidates to true.',
    );
  }

  const { unique: uniqueUris, duplicates } = dedupePreservingOrder(input.candidateTrackUris);
  const excludedUris = new Set(input.excludeTrackUris);

  const resolved: IGenerationCandidate[] = [];
  const preRejected: IGenerationRejection[] = duplicates.map((uri) => ({
    uri,
    reason: EGenerationRejection.Duplicate,
  }));

  const planOptions: IGenerationPlanOptions = {
    targetTrackCount: input.targetTrackCount,
    excludeTrackUris: input.excludeTrackUris,
    excludeArtists: input.excludeArtists,
    maxTracksPerArtist: input.maxTracksPerArtist,
  };

  let notEvaluated = 0;
  let plan = planGeneration(resolved, planOptions);

  const toLookup = uniqueUris.filter((uri) => !excludedUris.has(uri));
  for (const uri of uniqueUris.filter((candidate) => excludedUris.has(candidate))) {
    preRejected.push({ uri, reason: EGenerationRejection.ExcludedTrack });
  }

  if (!input.verifyCandidates) {
    for (const uri of toLookup) {
      resolved.push({
        source: 'candidate',
        track: {
          position: 0,
          kind: EPlaylistItemKind.Track,
          uri,
          id: idFromUri(uri),
          name: '',
          artists: [],
        },
      });
    }
    plan = planGeneration(resolved, planOptions);
    warnings.push('Candidates were not verified against Spotify (verifyCandidates: false).');
  } else {
    const batches = chunk(toLookup, GENERATION_LOOKUP_BATCH);
    for (const [batchIndex, batch] of batches.entries()) {
      const tracks = await Promise.all(batch.map((uri) => lookupTrack(spotify, uri)));
      batch.forEach((uri, index) => {
        const track = tracks[index];
        if (track) {
          resolved.push({ source: 'candidate', track });
        } else {
          preRejected.push({ uri, reason: EGenerationRejection.NotFound });
        }
      });
      plan = planGeneration(resolved, planOptions);
      if (plan.selected.length >= input.targetTrackCount) {
        notEvaluated += batches.slice(batchIndex + 1).reduce((sum, rest) => sum + rest.length, 0);
        break;
      }
    }
  }

  if (input.seedPlaylistId && plan.selected.length < input.targetTrackCount) {
    const page = await spotify.getPlaylistItems(input.seedPlaylistId, { all: true });
    const seedTracks = normalizePlaylistItems(page.items).tracks.filter(
      (track) => track.kind === EPlaylistItemKind.Track,
    );
    for (const track of seedTracks) {
      resolved.push({ source: 'seed', track });
    }
    plan = planGeneration(resolved, planOptions);
  }

  const rejected = [...preRejected, ...plan.rejected];
  const rejectedByReason: Partial<Record<EGenerationRejection, number>> = {};
  for (const entry of rejected) {
    rejectedByReason[entry.reason] = (rejectedByReason[entry.reason] ?? 0) + 1;
  }

  const result: IGeneratePlaylistResult = {
    status: EGenerationStatus.Preview,
    dryRun: input.dryRun,
    name: input.name,
    targetTrackCount: input.targetTrackCount,
    selectedCount: plan.selected.length,
    shortfall: plan.shortfall,
    preview: plan.selected.map(toPreview),
    rejectedByReason,
    rejected: rejected.slice(0, GENERATION_MAX_REPORTED_REJECTIONS),
    notEvaluated,
    ...(input.intent ? { intent: input.intent } : {}),
    warnings,
  };

  if (plan.shortfall > 0) {
    const guidance: IMoreCandidatesGuidance = {
      missingCount: plan.shortfall,
      artistsAtLimit: plan.artistsAtLimit,
      excludeUrisForNextSearch: [
        ...new Set([...plan.selected.map((track) => track.uri), ...input.excludeTrackUris]),
      ],
      suggestedTools: SUGGESTED_TOOLS,
      hint: 'Find more exact track URIs with the suggested tools and call generate_playlist again with the additional candidateTrackUris. No recommendations were invented.',
    };
    result.needsMoreCandidates = guidance;
  }

  if (input.dryRun) {
    result.status =
      plan.shortfall > 0 ? EGenerationStatus.NeedsMoreCandidates : EGenerationStatus.Preview;
    return result;
  }

  if (plan.selected.length === 0 || (plan.shortfall > 0 && !input.allowPartial)) {
    result.status = EGenerationStatus.NeedsMoreCandidates;
    warnings.push(
      'Nothing was created. Provide more candidates, or set allowPartial: true to create a shorter playlist.',
    );
    return result;
  }

  const creation = await createPlaylistWithTracks(
    spotify,
    {
      name: input.name,
      description: input.description,
      public: input.public,
      trackUris: plan.selected.map((track) => track.uri),
      allowDuplicateName: input.allowDuplicateName,
    },
    false,
  );
  result.creation = creation;
  result.status = creation.population.failed
    ? EGenerationStatus.CreatedWithErrors
    : EGenerationStatus.Created;
  return result;
}

