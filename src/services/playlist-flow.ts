import {
  EFlowStrategy,
  type IFlowEntry,
  type IFlowMetrics,
  type IFlowMove,
  type IFlowNeedsInput,
  type IFlowOptions,
  type IFlowPlan,
  type INormalizedTrack,
} from '../models/curation.js';
import { primaryArtistKey } from './playlist-items.js';

export const DEFAULT_FLOW_EDGE_COUNT = 3;
const MAX_REPORTED_MISSING_SCORES = 20;

function toEntry(track: INormalizedTrack): IFlowEntry {
  return {
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((artist) => artist.name),
    fromPosition: track.position,
  };
}

export function measureFlow(tracks: INormalizedTrack[]): IFlowMetrics {
  let adjacentSameArtistPairs = 0;
  let longestSameArtistRun = tracks.length > 0 ? 1 : 0;
  let run = 1;

  for (let index = 1; index < tracks.length; index += 1) {
    const previous = primaryArtistKey(tracks[index - 1]);
    const current = primaryArtistKey(tracks[index]);
    if (previous !== undefined && previous === current) {
      adjacentSameArtistPairs += 1;
      run += 1;
      longestSameArtistRun = Math.max(longestSameArtistRun, run);
    } else {
      run = 1;
    }
  }
  return { adjacentSameArtistPairs, longestSameArtistRun };
}

/** Takes one track per artist per round, artists ordered by first appearance. */
export function balanceArtists(tracks: INormalizedTrack[]): INormalizedTrack[] {
  const groups = new Map<string, INormalizedTrack[]>();
  tracks.forEach((track, index) => {
    const key = primaryArtistKey(track) ?? `unknown:${index}`;
    groups.set(key, [...(groups.get(key) ?? []), track]);
  });

  const queues = [...groups.values()];
  const result: INormalizedTrack[] = [];
  while (result.length < tracks.length) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) {
        result.push(next);
      }
    }
  }
  return result;
}

/**
 * Keeps the original order as much as possible while avoiding back-to-back
 * tracks by the same primary artist. An artist holding more than half of the
 * remaining tracks is placed immediately so repeats are not forced at the end.
 */
export function minimizeRepetition(tracks: INormalizedTrack[]): INormalizedTrack[] {
  const remaining = tracks.map((track, index) => ({
    track,
    key: primaryArtistKey(track) ?? `unknown:${index}`,
  }));
  const result: INormalizedTrack[] = [];
  let previousKey: string | undefined;

  while (remaining.length > 0) {
    const counts = new Map<string, number>();
    for (const entry of remaining) {
      counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
    }

    let pickIndex = -1;
    for (const [key, count] of counts) {
      if (key !== previousKey && count * 2 > remaining.length) {
        pickIndex = remaining.findIndex((entry) => entry.key === key);
        break;
      }
    }
    if (pickIndex === -1) {
      pickIndex = remaining.findIndex((entry) => entry.key !== previousKey);
    }
    if (pickIndex === -1) {
      pickIndex = 0;
    }

    const [picked] = remaining.splice(pickIndex, 1);
    result.push(picked.track);
    previousKey = picked.key;
  }
  return result;
}

function sortByScore(
  tracks: INormalizedTrack[],
  scores: Record<string, number>,
  direction: 'asc' | 'desc',
): INormalizedTrack[] {
  const sign = direction === 'asc' ? 1 : -1;
  return tracks
    .map((track, index) => ({ track, index }))
    .sort(
      (left, right) =>
        sign * (scores[left.track.uri] - scores[right.track.uri]) || left.index - right.index,
    )
    .map((entry) => entry.track);
}

function applyScoreStrategy(
  tracks: INormalizedTrack[],
  strategy: EFlowStrategy,
  scores: Record<string, number>,
  edgeCount: number,
): INormalizedTrack[] {
  const edge = Math.min(Math.max(edgeCount, 0), tracks.length);
  if (strategy === EFlowStrategy.GradualBuild) {
    return sortByScore(tracks, scores, 'asc');
  }

  const ranked = sortByScore(tracks, scores, strategy === EFlowStrategy.CalmStart ? 'asc' : 'desc');
  const chosen = new Set(ranked.slice(0, edge));
  const rest = tracks.filter((track) => !chosen.has(track));
  if (strategy === EFlowStrategy.CalmStart) {
    return [...ranked.slice(0, edge), ...rest];
  }
  // strong_finish: the highest-scored tracks close the playlist, lowest of them first.
  return [...rest, ...ranked.slice(0, edge).reverse()];
}

/** Orders `kept` to match `proposedOrder`, requiring an exact multiset match. */
function applyProposedOrder(kept: INormalizedTrack[], proposedOrder: string[]): INormalizedTrack[] {
  const pool = new Map<string, INormalizedTrack[]>();
  for (const track of kept) {
    pool.set(track.uri, [...(pool.get(track.uri) ?? []), track]);
  }

  const result: INormalizedTrack[] = [];
  const unknown: string[] = [];
  for (const uri of proposedOrder) {
    const next = pool.get(uri)?.shift();
    if (next) {
      result.push(next);
    } else {
      unknown.push(uri);
    }
  }
  const missing = [...pool.values()].flat().map((track) => track.uri);

  if (unknown.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (unknown.length > 0) {
      parts.push(`not in the playlist or repeated too often: ${unknown.slice(0, 5).join(', ')}`);
    }
    if (missing.length > 0) {
      parts.push(`playlist items missing from the proposed order: ${missing.slice(0, 5).join(', ')}`);
    }
    throw new Error(
      `proposedOrder must contain every playlist item exactly once (${parts.join('; ')}). Nothing was changed.`,
    );
  }
  return result;
}

/**
 * Computes a deterministic sequence for a playlist. Subjective strategies
 * need caller-supplied scores or an explicit order; energy, tempo and key are
 * never inferred. Returns a "needs input" result when that input is absent.
 */
export function planFlow(
  tracks: INormalizedTrack[],
  options: IFlowOptions,
): IFlowPlan | IFlowNeedsInput {
  const excludeUris = new Set(options.excludeUris ?? []);
  const kept = tracks.filter((track) => !excludeUris.has(track.uri));
  const excluded = tracks.filter((track) => excludeUris.has(track.uri));
  const { strategy } = options;
  const deterministic =
    strategy === EFlowStrategy.BalancedArtists || strategy === EFlowStrategy.MinimizeRepetition;

  if (deterministic && (options.scores || options.proposedOrder)) {
    throw new Error(
      `Strategy "${strategy}" is computed from artist metadata only; do not supply scores or proposedOrder (use "custom" for an explicit order).`,
    );
  }

  let ordered: INormalizedTrack[];
  if (strategy === EFlowStrategy.BalancedArtists) {
    ordered = balanceArtists(kept);
  } else if (strategy === EFlowStrategy.MinimizeRepetition) {
    ordered = minimizeRepetition(kept);
  } else if (options.proposedOrder) {
    ordered = applyProposedOrder(kept, options.proposedOrder);
  } else if (strategy === EFlowStrategy.Custom) {
    return {
      needsInput: true,
      reason: 'Strategy "custom" needs proposedOrder: a full ordering of the playlist item URIs.',
    };
  } else if (options.scores) {
    const missingScoreUris = kept
      .map((track) => track.uri)
      .filter((uri) => !Number.isFinite(options.scores?.[uri]));
    if (missingScoreUris.length > 0) {
      return {
        needsInput: true,
        reason: 'Every playlist item needs a numeric score for this strategy.',
        missingScoreUris: [...new Set(missingScoreUris)].slice(0, MAX_REPORTED_MISSING_SCORES),
      };
    }
    ordered = applyScoreStrategy(kept, strategy, options.scores, options.edgeCount);
  } else {
    return {
      needsInput: true,
      reason: `Strategy "${strategy}" is subjective. Supply scores (URI -> number, higher = more intense) or a full proposedOrder; this server does not compute energy, tempo or key.`,
    };
  }

  const keptIndex = new Map(kept.map((track, index) => [track, index]));
  const movedItems = ordered.filter((track, index) => keptIndex.get(track) !== index).length;

  return {
    order: ordered.map(toEntry),
    excluded: excluded.map(toEntry),
    before: measureFlow(kept),
    after: measureFlow(ordered),
    movedItems,
  };
}

/**
 * Converts a target ordering into Spotify reorder operations. `targetIndices[i]`
 * is the current index of the item that must end at position `i`. Each move
 * applies to the playlist as left by the previous move.
 */
export function computeReorderMoves(targetIndices: number[]): IFlowMove[] {
  const current = targetIndices.map((_, index) => index);
  const moves: IFlowMove[] = [];

  for (let target = 0; target < targetIndices.length; target += 1) {
    if (current[target] === targetIndices[target]) {
      continue;
    }
    const from = current.indexOf(targetIndices[target], target + 1);
    moves.push({ rangeStart: from, insertBefore: target });
    const [moved] = current.splice(from, 1);
    current.splice(target, 0, moved);
  }
  return moves;
}
