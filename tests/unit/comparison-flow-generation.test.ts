import { describe, expect, it } from 'vitest';
import {
  EFlowStrategy,
  EGenerationRejection,
  type IFlowPlan,
  type INormalizedTrack,
} from '../../src/models/curation.js';
import { comparePlaylists, jaccardSimilarity } from '../../src/services/playlist-comparison.js';
import {
  balanceArtists,
  computeReorderMoves,
  measureFlow,
  minimizeRepetition,
  planFlow,
} from '../../src/services/playlist-flow.js';
import { planGeneration } from '../../src/services/playlist-generation.js';
import { normalizePlaylistItems, normalizeTrack } from '../../src/services/playlist-items.js';
import { itemFixture, trackFixture } from '../helpers/fake-spotify.js';

function playlist(...tracks: Array<ReturnType<typeof trackFixture> | null>) {
  return normalizePlaylistItems(tracks.map((track) => itemFixture(track)) as never);
}

function tracksOf(spec: Array<[string, string]>): INormalizedTrack[] {
  return normalizePlaylistItems(
    spec.map(([id, artist]) => itemFixture(trackFixture(id, id, { artists: [artist] }))) as never,
  ).tracks;
}

const options = { maxListItems: 50, includeMergeCandidates: true };

describe('jaccardSimilarity', () => {
  it('is intersection over union', () => {
    expect(jaccardSimilarity(2, 6)).toBeCloseTo(1 / 3);
    expect(jaccardSimilarity(5, 5)).toBe(1);
    expect(jaccardSimilarity(0, 4)).toBe(0);
  });

  it('is defined as 0 when the union is empty', () => {
    expect(jaccardSimilarity(0, 0)).toBe(0);
  });
});

describe('comparePlaylists', () => {
  const a = playlist(trackFixture('t1'), trackFixture('t2'), trackFixture('t3'));
  const b = playlist(trackFixture('t3'), trackFixture('t4'));

  it('splits shared and exclusive tracks and computes Jaccard over unique IDs', () => {
    const result = comparePlaylists(a, b, options);
    expect(result.intersectionSize).toBe(1);
    expect(result.unionSize).toBe(4);
    expect(result.similarity).toBe(0.25);
    expect(result.shared.items.map((track) => track.uri)).toEqual(['spotify:track:t3']);
    expect(result.onlyInA.items.map((track) => track.uri)).toEqual(['spotify:track:t1', 'spotify:track:t2']);
    expect(result.onlyInB.items.map((track) => track.uri)).toEqual(['spotify:track:t4']);
    expect(result.mergeCandidates?.intoA.items.map((track) => track.uri)).toEqual(['spotify:track:t4']);
    expect(result.mergeCandidates?.intoB.count).toBe(2);
  });

  it('counts duplicates once for similarity but reports them', () => {
    const withDupes = playlist(trackFixture('t1'), trackFixture('t1'), trackFixture('t2'));
    const result = comparePlaylists(withDupes, playlist(trackFixture('t1')), options);
    expect(result.a).toMatchObject({ items: 3, uniqueTracks: 2, duplicateItems: 1 });
    expect(result.similarity).toBe(0.5);
  });

  it('reports identical playlists as fully similar', () => {
    expect(comparePlaylists(a, a, options).similarity).toBe(1);
  });

  it('handles empty playlists explicitly', () => {
    const empty = playlist();
    const both = comparePlaylists(empty, empty, options);
    expect(both.similarity).toBe(0);
    expect(both.unionSize).toBe(0);
    expect(both.notes.join(' ')).toMatch(/Both playlists have no comparable tracks/);

    const oneSide = comparePlaylists(a, empty, options);
    expect(oneSide.similarity).toBe(0);
    expect(oneSide.onlyInA.count).toBe(3);
    expect(oneSide.notes.join(' ')).toMatch(/Playlist B has no comparable tracks/);
  });

  it('computes artist overlap and durations', () => {
    const left = playlist(
      trackFixture('l1', 'L1', { artists: ['Shared'], durationMs: 1000 }),
      trackFixture('l2', 'L2', { artists: ['OnlyLeft'], durationMs: 2000 }),
    );
    const right = playlist(trackFixture('r1', 'R1', { artists: ['Shared'], durationMs: 4000 }));
    const result = comparePlaylists(left, right, options);
    expect(result.artistOverlap).toMatchObject({ sharedArtists: 1, uniqueArtistsA: 2, uniqueArtistsB: 1 });
    expect(result.artistOverlap.artistJaccard).toBe(0.5);
    expect(result.artistOverlap.top[0]).toEqual({ name: 'Shared', tracksInA: 1, tracksInB: 1 });
    expect(result.a.totalDurationMs).toBe(3000);
    expect(result.b.totalDurationMs).toBe(4000);
  });

  it('truncates long lists but keeps exact counts', () => {
    const big = playlist(...Array.from({ length: 10 }, (_, i) => trackFixture(`b${i}`)));
    const result = comparePlaylists(big, playlist(), { maxListItems: 3, includeMergeCandidates: false });
    expect(result.onlyInA).toMatchObject({ count: 10, truncated: true });
    expect(result.onlyInA.items).toHaveLength(3);
    expect(result.mergeCandidates).toBeUndefined();
  });

  it('keeps unavailable and non-track items out of the similarity set', () => {
    const local = { ...trackFixture('lc'), id: null, uri: 'spotify:local:a:b:c:1', is_local: true };
    const withExtras = normalizePlaylistItems([
      itemFixture(trackFixture('t1')),
      itemFixture(null),
      itemFixture(local, { is_local: true }),
    ] as never);
    const result = comparePlaylists(withExtras, playlist(trackFixture('t1')), options);
    expect(result.similarity).toBe(1);
    expect(result.a.nonTrackItems).toBe(2);
    expect(result.notes.join(' ')).toMatch(/excluded from the similarity/);
  });
});

describe('flow sequencing', () => {
  const spec: Array<[string, string]> = [
    ['1', 'A'], ['2', 'A'], ['3', 'A'], ['4', 'B'], ['5', 'B'], ['6', 'C'],
  ];

  it('balanced_artists round-robins artists in first-appearance order', () => {
    const order = balanceArtists(tracksOf(spec)).map((track) => track.name);
    expect(order).toEqual(['1', '4', '6', '2', '5', '3']);
  });

  it('minimize_repetition removes adjacent repeats when possible and stays near the original order', () => {
    const tracks = tracksOf([['1', 'A'], ['2', 'A'], ['3', 'B'], ['4', 'B'], ['5', 'C']]);
    const ordered = minimizeRepetition(tracks);
    expect(measureFlow(ordered).adjacentSameArtistPairs).toBe(0);
    expect(ordered).toHaveLength(5);
    expect(ordered[0].name).toBe('1');
  });

  it('minimize_repetition places a dominant artist early so repeats are not stranded at the end', () => {
    const tracks = tracksOf([['1', 'A'], ['2', 'A'], ['3', 'A'], ['4', 'B'], ['5', 'C']]);
    const ordered = minimizeRepetition(tracks);
    expect(measureFlow(ordered).adjacentSameArtistPairs).toBe(0);
  });

  it('keeps every item when repetition is unavoidable', () => {
    const tracks = tracksOf([['1', 'A'], ['2', 'A'], ['3', 'A']]);
    expect(minimizeRepetition(tracks).map((track) => track.name).sort()).toEqual(['1', '2', '3']);
  });

  it('measures runs of the same primary artist', () => {
    expect(measureFlow(tracksOf(spec))).toEqual({ adjacentSameArtistPairs: 3, longestSameArtistRun: 3 });
    expect(measureFlow([])).toEqual({ adjacentSameArtistPairs: 0, longestSameArtistRun: 0 });
  });

  const base = { edgeCount: 2 };
  const scored = tracksOf([['1', 'A'], ['2', 'B'], ['3', 'C'], ['4', 'D'], ['5', 'E']]);
  const scores = { 'spotify:track:1': 5, 'spotify:track:2': 1, 'spotify:track:3': 9, 'spotify:track:4': 3, 'spotify:track:5': 7 };
  const names = (plan: unknown) => (plan as IFlowPlan).order.map((entry) => entry.name);

  it('gradual_build sorts ascending by supplied scores', () => {
    expect(names(planFlow(scored, { ...base, strategy: EFlowStrategy.GradualBuild, scores }))).toEqual(['2', '4', '1', '5', '3']);
  });

  it('calm_start leads with the calmest tracks and keeps the rest in place', () => {
    expect(names(planFlow(scored, { ...base, strategy: EFlowStrategy.CalmStart, scores }))).toEqual(['2', '4', '1', '3', '5']);
  });

  it('strong_finish ends with the most intense tracks, lowest of them first', () => {
    expect(names(planFlow(scored, { ...base, strategy: EFlowStrategy.StrongFinish, scores }))).toEqual(['1', '2', '4', '5', '3']);
  });

  it('asks for input instead of inventing energy for subjective strategies', () => {
    const result = planFlow(scored, { ...base, strategy: EFlowStrategy.GradualBuild });
    expect(result).toMatchObject({ needsInput: true });
    expect((result as { reason: string }).reason).toMatch(/does not compute energy/);
  });

  it('reports which tracks lack scores', () => {
    const partial = { 'spotify:track:1': 1 };
    const result = planFlow(scored, { ...base, strategy: EFlowStrategy.GradualBuild, scores: partial });
    expect(result).toMatchObject({ needsInput: true });
    expect((result as { missingScoreUris: string[] }).missingScoreUris).toHaveLength(4);
  });

  it('accepts an AI-proposed order for custom and validates it', () => {
    const proposedOrder = ['5', '4', '3', '2', '1'].map((id) => `spotify:track:${id}`);
    const plan = planFlow(scored, { ...base, strategy: EFlowStrategy.Custom, proposedOrder }) as IFlowPlan;
    expect(plan.order.map((entry) => entry.name)).toEqual(['5', '4', '3', '2', '1']);
    expect(plan.movedItems).toBe(4);

    expect(planFlow(scored, { ...base, strategy: EFlowStrategy.Custom })).toMatchObject({ needsInput: true });
    expect(() =>
      planFlow(scored, { ...base, strategy: EFlowStrategy.Custom, proposedOrder: proposedOrder.slice(1) }),
    ).toThrow(/every playlist item exactly once/);
    expect(() =>
      planFlow(scored, { ...base, strategy: EFlowStrategy.Custom, proposedOrder: [...proposedOrder, 'spotify:track:zzz'] }),
    ).toThrow(/not in the playlist/);
  });

  it('rejects scores for the metadata-only strategies', () => {
    expect(() => planFlow(scored, { ...base, strategy: EFlowStrategy.BalancedArtists, scores })).toThrow(/artist metadata only/);
  });

  it('preserves every item unless an exclusion is requested', () => {
    const plan = planFlow(tracksOf(spec), { ...base, strategy: EFlowStrategy.BalancedArtists }) as IFlowPlan;
    expect(plan.order).toHaveLength(spec.length);
    expect(plan.excluded).toEqual([]);

    const excluding = planFlow(tracksOf(spec), {
      ...base,
      strategy: EFlowStrategy.BalancedArtists,
      excludeUris: ['spotify:track:6'],
    }) as IFlowPlan;
    expect(excluding.order).toHaveLength(spec.length - 1);
    expect(excluding.excluded.map((entry) => entry.name)).toEqual(['6']);
  });

  it('reports objective before/after repetition metrics', () => {
    const plan = planFlow(tracksOf(spec), { ...base, strategy: EFlowStrategy.BalancedArtists }) as IFlowPlan;
    expect(plan.before.adjacentSameArtistPairs).toBe(3);
    expect(plan.after.adjacentSameArtistPairs).toBe(0);
  });
});

describe('computeReorderMoves', () => {
  function applyMoves(count: number, moves: Array<{ rangeStart: number; insertBefore: number }>) {
    const list = Array.from({ length: count }, (_, i) => i);
    for (const move of moves) {
      const [item] = list.splice(move.rangeStart, 1);
      list.splice(move.insertBefore, 0, item);
    }
    return list;
  }

  it('needs no moves for an unchanged order', () => {
    expect(computeReorderMoves([0, 1, 2])).toEqual([]);
  });

  it.each([
    [[2, 0, 1]],
    [[4, 3, 2, 1, 0]],
    [[1, 0, 3, 2, 5, 4]],
    [[0, 2, 1, 3]],
  ])('produces moves that reach the target %j', (target) => {
    const moves = computeReorderMoves(target);
    expect(applyMoves(target.length, moves)).toEqual(target);
    expect(moves.length).toBeLessThan(target.length);
    for (const move of moves) {
      expect(move.rangeStart).toBeGreaterThan(move.insertBefore);
    }
  });
});

describe('planGeneration', () => {
  const candidate = (id: string, artist = 'Artist One') => ({
    source: 'candidate' as const,
    track: normalizeTrack(trackFixture(id, `Track ${id}`, { artists: [artist] }) as never),
  });
  const plan = (candidates: ReturnType<typeof candidate>[], overrides = {}) =>
    planGeneration(candidates, { targetTrackCount: 3, excludeTrackUris: [], excludeArtists: [], ...overrides });

  it('selects up to the target in candidate order', () => {
    const result = plan([candidate('1', 'A'), candidate('2', 'B'), candidate('3', 'C'), candidate('4', 'D')]);
    expect(result.selected.map((track) => track.id)).toEqual(['1', '2', '3']);
    expect(result.rejectedByReason).toEqual({ [EGenerationRejection.OverTarget]: 1 });
    expect(result.shortfall).toBe(0);
  });

  it('removes duplicates', () => {
    const result = plan([candidate('1', 'A'), candidate('1', 'A'), candidate('2', 'B')]);
    expect(result.selected.map((track) => track.id)).toEqual(['1', '2']);
    expect(result.rejectedByReason[EGenerationRejection.Duplicate]).toBe(1);
    expect(result.shortfall).toBe(1);
  });

  it('honors excluded tracks and artists (by name or ID)', () => {
    const result = plan(
      [candidate('1', 'A'), candidate('2', 'Banned'), candidate('3', 'C'), candidate('4', 'D')],
      { excludeTrackUris: ['spotify:track:1'], excludeArtists: ['banned'] },
    );
    expect(result.selected.map((track) => track.id)).toEqual(['3', '4']);
    expect(result.rejectedByReason).toEqual({
      [EGenerationRejection.ExcludedTrack]: 1,
      [EGenerationRejection.ExcludedArtist]: 1,
    });

    const byId = plan([candidate('2', 'Banned')], { excludeArtists: ['arBanned'] });
    expect(byId.selected).toEqual([]);
  });

  it('limits tracks per primary artist and names the artists at the limit', () => {
    const result = plan(
      [candidate('1', 'A'), candidate('2', 'A'), candidate('3', 'A'), candidate('4', 'B')],
      { maxTracksPerArtist: 2 },
    );
    expect(result.selected.map((track) => track.id)).toEqual(['1', '2', '4']);
    expect(result.artistsAtLimit).toEqual(['A']);
    expect(result.rejectedByReason[EGenerationRejection.ArtistLimit]).toBe(1);
  });

  it('reports a shortfall instead of inventing tracks', () => {
    const result = plan([candidate('1', 'A')], { targetTrackCount: 5 });
    expect(result.selected).toHaveLength(1);
    expect(result.shortfall).toBe(4);
  });
});
