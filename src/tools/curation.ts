import { z } from 'zod';
import {
  EFlowStatus,
  EFlowStrategy,
  type IFlowEntry,
  type IFlowMove,
  type IFlowNeedsInput,
  type IFlowPlan,
  type INormalizedPlaylist,
  type INormalizedTrack,
} from '../models/curation.js';
import { analyzePlaylist } from '../services/playlist-analysis.js';
import { comparePlaylists } from '../services/playlist-comparison.js';
import {
  DEFAULT_FLOW_EDGE_COUNT,
  computeReorderMoves,
  planFlow,
} from '../services/playlist-flow.js';
import { generatePlaylist } from '../services/playlist-generation.js';
import { normalizePlaylistItems } from '../services/playlist-items.js';
import type { SpotifyClient } from '../spotify.js';
import { chunk, spotifyIdSchema, spotifyPlaylistItemUriSchema, spotifyTrackUriSchema } from '../utils/uri.js';
import {
  PLAYLIST_DESCRIPTION_MAX_LENGTH,
  PLAYLIST_NAME_MAX_LENGTH,
} from '../services/playlist-creation.js';
import {
  assertSnapshotMatches,
  errorResult,
  jsonErrorResult,
  jsonResult,
  type IToolContext,
} from './shared.js';

/** Applying an order costs one Spotify call per move; refuse unreasonable plans. */
export const MAX_FLOW_MOVES = 200;

interface ILoadedPlaylist {
  name?: string;
  snapshotId?: string;
  playlist: INormalizedPlaylist;
}

async function loadPlaylist(spotify: SpotifyClient, playlistId: string): Promise<ILoadedPlaylist> {
  const details = await spotify.getPlaylist(playlistId);
  const page = await spotify.getPlaylistItems(playlistId, { all: true });
  return {
    name: details.name,
    snapshotId: details.snapshot_id,
    playlist: normalizePlaylistItems(page.items),
  };
}

function toOriginalEntry(track: INormalizedTrack): IFlowEntry {
  return {
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((artist) => artist.name),
    fromPosition: track.position,
  };
}

function isNeedsInput(plan: IFlowPlan | IFlowNeedsInput): plan is IFlowNeedsInput {
  return 'needsInput' in plan;
}

/** Reorder operations that turn the (exclusion-filtered) playlist into `plan.order`. */
function movesForPlan(kept: INormalizedTrack[], plan: IFlowPlan): IFlowMove[] {
  const indexByPosition = new Map(kept.map((track, index) => [track.position, index]));
  return computeReorderMoves(plan.order.map((entry) => indexByPosition.get(entry.fromPosition) ?? 0));
}

export function registerCurationTools({ registerTool, spotify }: IToolContext): void {
  registerTool(
    'generate_playlist',
    {
      description:
        'Turn a selection of candidate tracks into a validated playlist. YOU choose the music (using search_tracks, get_top_items, get_liked_tracks, etc.); this tool verifies each candidate URI exists, removes duplicates and excluded tracks/artists, applies an optional per-artist limit, and previews the result. dryRun defaults to TRUE: nothing is created until you pass dryRun: false. If there are too few valid candidates it returns needs_more_candidates guidance and creates nothing (unless allowPartial). It never invents recommendations.',
      inputSchema: {
        name: z.string().trim().min(1).max(PLAYLIST_NAME_MAX_LENGTH),
        description: z.string().max(PLAYLIST_DESCRIPTION_MAX_LENGTH).optional(),
        targetTrackCount: z.number().int().min(1).max(100).default(20),
        public: z.boolean().default(false),
        candidateTrackUris: z.array(spotifyTrackUriSchema).max(200).default([]),
        seedPlaylistId: spotifyIdSchema.optional().describe('Use this playlist\'s tracks as extra candidates, after candidateTrackUris'),
        excludeTrackUris: z.array(spotifyTrackUriSchema).max(500).default([]),
        excludeArtists: z.array(z.string().min(1)).max(50).default([]).describe('Artist names or IDs to leave out'),
        maxTracksPerArtist: z.number().int().min(1).max(20).optional().describe('Limit by each track\'s primary artist'),
        verifyCandidates: z.boolean().default(true),
        allowPartial: z.boolean().default(false),
        allowDuplicateName: z.boolean().default(false),
        intent: z
          .object({
            mood: z.string().optional(),
            genres: z.array(z.string()).optional(),
            artists: z.array(z.string()).optional(),
            notes: z.string().optional(),
          })
          .optional()
          .describe('Free-form intent metadata echoed back; it is not interpreted'),
        dryRun: z.boolean().default(true),
      },
    },
    async (input) => {
      try {
        const result = await generatePlaylist(spotify, {
          ...input,
          description: input.description,
        });
        return result.creation?.population.failed ? jsonErrorResult(result) : jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'analyze_playlist',
    {
      description:
        'Objective statistics for a playlist: counts, duplicates, duration, artist frequency and concentration, album and release-year distribution, explicit split, missing/unavailable metadata, and measurable suggestions. Read-only. No popularity or audio features are used.',
      inputSchema: {
        playlistId: spotifyIdSchema,
      },
    },
    async ({ playlistId }) => {
      try {
        const loaded = await loadPlaylist(spotify, playlistId);
        return jsonResult({
          playlistId,
          name: loaded.name,
          ...(loaded.snapshotId ? { snapshotId: loaded.snapshotId } : {}),
          analysis: analyzePlaylist(loaded.playlist),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'compare_playlists',
    {
      description:
        'Compare two playlists by unique Spotify track ID: shared and exclusive tracks, duplicate counts, artist overlap, durations, Jaccard similarity (intersection / union; 0 when both are empty), and optional merge candidates. Read-only; never modifies either playlist. Use add_unique_playlist_items to act on merge candidates.',
      inputSchema: {
        playlistIdA: spotifyIdSchema,
        playlistIdB: spotifyIdSchema,
        maxListItems: z.number().int().min(1).max(200).default(50),
        includeMergeCandidates: z.boolean().default(true),
      },
    },
    async ({ playlistIdA, playlistIdB, maxListItems, includeMergeCandidates }) => {
      try {
        if (playlistIdA === playlistIdB) {
          throw new Error('Choose two different playlists to compare.');
        }
        const [a, b] = await Promise.all([
          loadPlaylist(spotify, playlistIdA),
          loadPlaylist(spotify, playlistIdB),
        ]);
        return jsonResult({
          playlistA: { id: playlistIdA, name: a.name, snapshotId: a.snapshotId },
          playlistB: { id: playlistIdB, name: b.name, snapshotId: b.snapshotId },
          ...comparePlaylists(a.playlist, b.playlist, { maxListItems, includeMergeCandidates }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    'suggest_playlist_flow',
    {
      description:
        'Propose a better listening order for a playlist and optionally apply it. balanced_artists and minimize_repetition are computed from artist metadata. gradual_build, calm_start and strong_finish are subjective: supply `scores` (URI -> number, higher = more intense) or a full `proposedOrder`; energy/tempo/key are never inferred. custom needs `proposedOrder`. dryRun defaults to TRUE and returns the original and proposed order. With dryRun: false the order is applied with reorder operations (guarded by the snapshot; use expectedSnapshotId from a preview). excludeUris would REMOVE items and additionally requires confirmRemoval: true. Does not touch Spotify\'s Mix/Smart Reorder, which is only available in the Spotify app.',
      inputSchema: {
        playlistId: spotifyIdSchema,
        strategy: z.nativeEnum(EFlowStrategy),
        scores: z.record(spotifyPlaylistItemUriSchema, z.number().finite()).optional(),
        proposedOrder: z.array(spotifyPlaylistItemUriSchema).max(10_000).optional(),
        excludeUris: z.array(spotifyPlaylistItemUriSchema).max(100).optional(),
        edgeCount: z.number().int().min(1).max(20).default(DEFAULT_FLOW_EDGE_COUNT),
        expectedSnapshotId: z.string().min(1).optional(),
        confirmRemoval: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      },
    },
    async ({
      playlistId,
      strategy,
      scores,
      proposedOrder,
      excludeUris,
      edgeCount,
      expectedSnapshotId,
      confirmRemoval,
      dryRun,
    }) => {
      try {
        const loaded = await loadPlaylist(spotify, playlistId);
        assertSnapshotMatches(expectedSnapshotId, loaded.snapshotId);

        const { playlist } = loaded;
        const warnings: string[] = [];
        if (playlist.unavailablePositions.length > 0) {
          warnings.push(
            `${playlist.unavailablePositions.length} unavailable item(s) have no URI and are not part of the proposal.`,
          );
        }

        const plan = planFlow(playlist.tracks, {
          strategy,
          scores,
          proposedOrder,
          excludeUris,
          edgeCount,
        });
        if (isNeedsInput(plan)) {
          return jsonResult({ status: EFlowStatus.NeedsInput, playlistId, strategy, ...plan });
        }

        const excludeSet = new Set(excludeUris ?? []);
        const kept = playlist.tracks.filter((track) => !excludeSet.has(track.uri));
        const moves = movesForPlan(kept, plan);
        const changes = {
          movedItems: plan.movedItems,
          reorderOperations: moves.length,
          removedItems: plan.excluded.length,
          adjacentSameArtistPairs: { before: plan.before.adjacentSameArtistPairs, after: plan.after.adjacentSameArtistPairs },
          longestSameArtistRun: { before: plan.before.longestSameArtistRun, after: plan.after.longestSameArtistRun },
        };
        const base = {
          playlistId,
          name: loaded.name,
          ...(loaded.snapshotId ? { snapshotId: loaded.snapshotId } : {}),
          strategy,
          originalOrder: playlist.tracks.map(toOriginalEntry),
          proposedOrder: plan.order,
          ...(plan.excluded.length > 0 ? { excluded: plan.excluded } : {}),
          changes,
          warnings,
        };

        if (moves.length === 0 && plan.excluded.length === 0) {
          return jsonResult({ ...base, status: EFlowStatus.NoChange, dryRun });
        }
        if (dryRun) {
          if (plan.excluded.length > 0) {
            warnings.push('excludeUris would remove items from the playlist; applying requires confirmRemoval: true.');
          }
          return jsonResult({ ...base, status: EFlowStatus.Preview, dryRun: true });
        }

        // ---- Apply (explicit dryRun: false) ----
        if (playlist.unavailablePositions.length > 0) {
          throw new Error(
            'This playlist has unavailable items without URIs, so playlist positions cannot be mapped safely. Nothing was changed; use dryRun: true to preview.',
          );
        }
        if (plan.excluded.length > 0 && !confirmRemoval) {
          throw new Error(
            `excludeUris would remove ${plan.excluded.length} item(s) from the playlist. Nothing was changed; pass confirmRemoval: true to proceed.`,
          );
        }
        if (moves.length > MAX_FLOW_MOVES) {
          throw new Error(
            `Applying this order needs ${moves.length} reorder operations (limit ${MAX_FLOW_MOVES}). Nothing was changed; use a smaller playlist or reorder in steps.`,
          );
        }

        let snapshot = loaded.snapshotId;
        let removed = 0;
        let applied = 0;
        try {
          if (plan.excluded.length > 0) {
            const uris = [...new Set(plan.excluded.map((entry) => entry.uri))];
            for (const batch of chunk(uris, 100)) {
              const result = await spotify.removePlaylistItems({ playlistId, uris: batch, snapshotId: snapshot });
              snapshot = result.snapshot_id;
            }
            removed = plan.excluded.length;
          }
          for (const move of moves) {
            const result = await spotify.reorderPlaylistItems({
              playlistId,
              rangeStart: move.rangeStart,
              insertBefore: move.insertBefore,
              snapshotId: snapshot,
            });
            snapshot = result.snapshot_id;
            applied += 1;
          }
        } catch (error) {
          return jsonErrorResult({
            ...base,
            status: 'partial_failure',
            dryRun: false,
            applied: { removedItems: removed, reorderOperations: applied, of: moves.length },
            error: error instanceof Error ? error.message : String(error),
            warnings: [...warnings, 'Playlist order may be partly changed. Re-read it (get_playlist_summary) before retrying.'],
          });
        }

        return jsonResult({
          ...base,
          status: EFlowStatus.Applied,
          dryRun: false,
          resultingSnapshotId: snapshot,
          applied: { removedItems: removed, reorderOperations: applied, of: moves.length },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
