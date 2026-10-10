import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeSpotify,
  itemFixture,
  pagedRoute,
  playlistFixture,
  startSession,
  trackFixture,
  type ITrackFixtureOptions,
  type McpTestSession,
} from '../helpers/fake-spotify.js';

let session: McpTestSession | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
});

type TTrack = ReturnType<typeof trackFixture> | null;

const meFake = () => new FakeSpotify().on('GET', '/me', { id: 'me-user' });

/** A playlist whose reads, reorders and removals are applied to in-memory state. */
function statefulPlaylist(
  fake: FakeSpotify,
  id: string,
  initial: TTrack[],
  name = `Playlist ${id}`,
  failReorderNumber?: number,
) {
  const state = { items: [...initial], version: 0, reorders: 0 };
  const snapshot = () => `${id}-v${state.version}`;
  const bump = () => {
    state.version += 1;
    return { snapshot_id: snapshot() };
  };

  fake.on('GET', `/playlists/${id}`, () => playlistFixture(id, name, 'me-user', { snapshot_id: snapshot() }));
  fake.on('GET', `/playlists/${id}/items`, (request) => pagedRoute(state.items.map((track) => itemFixture(track)))(request));
  fake.on('PUT', `/playlists/${id}/items`, ({ body }) => {
    state.reorders += 1;
    if (state.reorders === failReorderNumber) {
      return { status: 500, body: { error: { status: 500, message: 'down' } } };
    }
    const { range_start, insert_before, range_length = 1 } = body as { range_start: number; insert_before: number; range_length?: number };
    const moved = state.items.splice(range_start, range_length);
    state.items.splice(insert_before, 0, ...moved);
    return bump();
  });
  fake.on('DELETE', `/playlists/${id}/items`, ({ body }) => {
    const uris = new Set((body as { items: Array<{ uri: string }> }).items.map((item) => item.uri));
    state.items = state.items.filter((track) => !track || !uris.has(track.uri));
    return bump();
  });
  return state;
}

const t = (id: string, artist = 'Artist One', options: ITrackFixtureOptions = {}) =>
  trackFixture(id, `Song ${id}`, { artists: [artist], ...options });

describe('analyze_playlist', () => {
  it('reads every page once and returns structured statistics', async () => {
    const tracks = Array.from({ length: 150 }, (_, i) => t(`a${i}`, i < 60 ? 'Main Act' : `Other ${i % 40}`, { releaseDate: `${1990 + (i % 30)}-01-01`, explicit: i % 3 === 0 }));
    tracks.push(tracks[0]);
    const fake = meFake();
    statefulPlaylist(fake, 'pl1', tracks, 'Big mix');
    session = await startSession(fake);

    const result = await session.call('analyze_playlist', { playlistId: 'pl1' });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ playlistId: 'pl1', name: 'Big mix', snapshotId: 'pl1-v0' });
    const { analysis } = result.json;
    expect(analysis.totalItems).toBe(151);
    expect(analysis.uniqueTracks).toBe(150);
    expect(analysis.duplicateItemCount).toBe(1);
    expect(analysis.topArtists[0]).toMatchObject({ name: 'Main Act', trackCount: 61 });
    expect(analysis.concentration.topArtistShare).toBeGreaterThan(0.25);
    expect(analysis.suggestions.map((suggestion: { code: string }) => suggestion.code)).toEqual(
      expect.arrayContaining(['duplicate_tracks', 'artist_concentration']),
    );
    expect(analysis.releaseYearRange).toEqual({ oldest: 1990, newest: 2019 });
    expect(Object.keys(analysis.releaseYears)).toHaveLength(30);
    expect(analysis.explicit.explicit).toBeGreaterThan(0);

    // 1 metadata read + ceil(151 / 100) = 2 item pages; nothing else.
    expect(fake.requests.filter((request) => request.path.startsWith('/playlists/'))).toHaveLength(3);
    expect(fake.mutations).toHaveLength(0);
  });

  it('handles unavailable items and empty playlists', async () => {
    const fake = meFake();
    statefulPlaylist(fake, 'pl1', [t('a'), null, t('b')]);
    statefulPlaylist(fake, 'pl2', []);
    session = await startSession(fake);

    const gaps = await session.call('analyze_playlist', { playlistId: 'pl1' });
    expect(gaps.json.analysis.totalItems).toBe(3);
    expect(gaps.json.analysis.missingMetadata.unavailableItems).toBe(1);

    const empty = await session.call('analyze_playlist', { playlistId: 'pl2' });
    expect(empty.json.analysis).toMatchObject({ totalItems: 0, uniqueTracks: 0, concentration: null });
  });

  it('reports a playlist the app cannot read', async () => {
    const fake = meFake()
      .on('GET', '/playlists/private1', playlistFixture('private1', 'Not mine', 'other'))
      .on('GET', '/playlists/private1/items', { status: 403, body: { error: { status: 403, message: 'Forbidden' } } });
    session = await startSession(fake);
    const result = await session.call('analyze_playlist', { playlistId: 'private1' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Spotify API 403/);
    expect(result.text).toMatch(/Development Mode/);
  });
});

describe('compare_playlists', () => {
  it('compares two playlists without modifying either', async () => {
    const fake = meFake();
    statefulPlaylist(fake, 'plA', [t('s1', 'Shared Act'), t('s2'), t('a1', 'Only A')]);
    statefulPlaylist(fake, 'plB', [t('s2'), t('b1', 'Shared Act'), t('b2', 'Only B')]);
    session = await startSession(fake);

    const result = await session.call('compare_playlists', { playlistIdA: 'plA', playlistIdB: 'plB' });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({
      intersectionSize: 1,
      unionSize: 5,
      similarity: 0.2,
      playlistA: { id: 'plA' },
      playlistB: { id: 'plB' },
    });
    expect(result.json.shared.items.map((track: { uri: string }) => track.uri)).toEqual(['spotify:track:s2']);
    expect(result.json.onlyInA.count).toBe(2);
    expect(result.json.onlyInB.count).toBe(2);
    expect(result.json.artistOverlap.top.map((entry: { name: string }) => entry.name)).toContain('Shared Act');
    expect(result.json.mergeCandidates.intoA.items.map((track: { uri: string }) => track.uri)).toEqual(['spotify:track:b1', 'spotify:track:b2']);
    expect(fake.mutations).toHaveLength(0);
  });

  it('explains empty playlists and rejects comparing a playlist with itself', async () => {
    const fake = meFake();
    statefulPlaylist(fake, 'plA', []);
    statefulPlaylist(fake, 'plB', []);
    session = await startSession(fake);

    const empty = await session.call('compare_playlists', { playlistIdA: 'plA', playlistIdB: 'plB', includeMergeCandidates: false });
    expect(empty.json.similarity).toBe(0);
    expect(empty.json.notes.join(' ')).toMatch(/Both playlists have no comparable tracks/);
    expect(empty.json.mergeCandidates).toBeUndefined();

    const same = await session.call('compare_playlists', { playlistIdA: 'plA', playlistIdB: 'plA' });
    expect(same.isError).toBe(true);
  });
});

describe('generate_playlist', () => {
  /** Spotify knows tracks k1..k20 by Artist K1..; unknown IDs return 404. */
  function generationFake(knownIds: string[] = Array.from({ length: 20 }, (_, i) => `k${i + 1}`)) {
    const known = new Map(knownIds.map((id, index) => [id, t(id, `Artist ${index % 5}`)]));
    return meFake()
      .on('GET', /^\/tracks\/\w+$/, ({ path }) => {
        const track = known.get(path.split('/').pop() ?? '');
        return track ?? { status: 404, body: { error: { status: 404, message: 'Non existing id' } } };
      })
      .on('GET', '/me/playlists', pagedRoute([]))
      .on('POST', '/me/playlists', ({ body }) => playlistFixture('gen1', (body as { name: string }).name, 'me-user', { public: false }))
      .on('POST', '/playlists/gen1/items', { snapshot_id: 'g1' });
  }
  const uris = (...ids: string[]) => ids.map((id) => `spotify:track:${id}`);

  it('defaults to a dry run: validates and previews but never mutates', async () => {
    const fake = generationFake();
    session = await startSession(fake);
    const result = await session.call('generate_playlist', {
      name: 'Gym',
      targetTrackCount: 3,
      candidateTrackUris: uris('k1', 'k2', 'k2', 'zzz', 'k3', 'k4'),
      intent: { mood: 'energetic', genres: ['metal'] },
    });

    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ status: 'preview', dryRun: true, selectedCount: 3, shortfall: 0, intent: { mood: 'energetic' } });
    expect(result.json.preview.map((track: { uri: string }) => track.uri)).toEqual(uris('k1', 'k2', 'k3'));
    expect(result.json.preview[0]).toEqual({ uri: 'spotify:track:k1', name: 'Song k1', artists: ['Artist 0'] });
    expect(result.json.rejectedByReason).toMatchObject({ duplicate: 1, not_found: 1, over_target: 1 });
    expect(result.json.notEvaluated).toBe(0);
    expect(fake.mutations).toHaveLength(0);
  });

  it('creates the playlist only with dryRun: false, reusing the creation path', async () => {
    const fake = generationFake();
    session = await startSession(fake);
    const result = await session.call('generate_playlist', {
      name: 'Gym',
      description: 'lift',
      targetTrackCount: 3,
      candidateTrackUris: uris('k1', 'k2', 'k3', 'k4'),
      dryRun: false,
    });

    expect(result.json.status).toBe('created');
    expect(result.json.creation).toMatchObject({ created: true, playlist: { id: 'gen1' }, population: { addedUris: uris('k1', 'k2', 'k3') } });
    expect(fake.mutations.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /me/playlists',
      'POST /playlists/gen1/items',
    ]);
    expect(fake.mutations[0].body).toEqual({ name: 'Gym', public: false, description: 'lift' });
  });

  it('honors excluded tracks and artists and the per-artist limit', async () => {
    const fake = generationFake();
    session = await startSession(fake);
    // Artists cycle by track number: k1,k6,k11 -> Artist 0; k2 -> 1; k3,k8 -> 2; k4 -> 3; k5 -> 4.
    const result = await session.call('generate_playlist', {
      name: 'Variety',
      targetTrackCount: 6,
      candidateTrackUris: uris('k1', 'k6', 'k11', 'k2', 'k3', 'k8', 'k4', 'k5'),
      excludeTrackUris: uris('k3'),
      excludeArtists: ['artist 3'],
      maxTracksPerArtist: 1,
    });

    expect(result.json.preview.map((track: { uri: string }) => track.uri)).toEqual(uris('k1', 'k2', 'k8', 'k5'));
    expect(result.json.rejectedByReason).toEqual({ excluded_track: 1, excluded_artist: 1, artist_limit: 2 });
    expect(result.json.shortfall).toBe(2);
    expect(result.json.needsMoreCandidates.artistsAtLimit).toEqual(['Artist 0']);
    expect(fake.mutations).toHaveLength(0);
  });

  it('returns guidance instead of inventing songs when candidates run short', async () => {
    const fake = generationFake();
    session = await startSession(fake);
    const result = await session.call('generate_playlist', { name: 'Short', targetTrackCount: 5, candidateTrackUris: uris('k1', 'k2') });

    expect(result.json).toMatchObject({ status: 'needs_more_candidates', selectedCount: 2, shortfall: 3 });
    expect(result.json.needsMoreCandidates).toMatchObject({ missingCount: 3 });
    expect(result.json.needsMoreCandidates.excludeUrisForNextSearch).toEqual(uris('k1', 'k2'));
    expect(result.json.needsMoreCandidates.suggestedTools).toContain('search_tracks');
    expect(result.json.needsMoreCandidates.hint).toMatch(/No recommendations were invented/);
  });

  it('does not create a short playlist unless allowPartial is set', async () => {
    const fake = generationFake();
    session = await startSession(fake);
    const refused = await session.call('generate_playlist', { name: 'Short', targetTrackCount: 5, candidateTrackUris: uris('k1', 'k2'), dryRun: false });
    expect(refused.json.status).toBe('needs_more_candidates');
    expect(refused.json.warnings.join(' ')).toMatch(/Nothing was created/);
    expect(fake.mutations).toHaveLength(0);

    const empty = await session.call('generate_playlist', { name: 'None', allowPartial: true, dryRun: false });
    expect(empty.json.status).toBe('needs_more_candidates');
    expect(fake.mutations).toHaveLength(0);

    const partial = await session.call('generate_playlist', { name: 'Short', targetTrackCount: 5, candidateTrackUris: uris('k1', 'k2'), dryRun: false, allowPartial: true });
    expect(partial.json.status).toBe('created');
    expect(partial.json.creation.population.addedUris).toEqual(uris('k1', 'k2'));
  });

  it('uses a seed playlist as extra candidates after the explicit ones', async () => {
    const fake = generationFake();
    statefulPlaylist(fake, 'seed1', [t('k9', 'Seed Act'), t('k1', 'Artist 0'), null, t('k10', 'Seed Act')]);
    session = await startSession(fake);

    const result = await session.call('generate_playlist', {
      name: 'From seed',
      targetTrackCount: 3,
      candidateTrackUris: uris('k1'),
      seedPlaylistId: 'seed1',
    });
    expect(result.json.preview.map((track: { uri: string }) => track.uri)).toEqual(uris('k1', 'k9', 'k10'));
    expect(result.json.rejectedByReason.duplicate).toBe(1);
    expect(fake.mutations).toHaveLength(0);
  });

  it('refuses artist rules when verification is switched off', async () => {
    const fake = generationFake();
    session = await startSession(fake);
    const result = await session.call('generate_playlist', { name: 'x', candidateTrackUris: uris('k1'), verifyCandidates: false, maxTracksPerArtist: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/need track metadata/);

    const unverified = await session.call('generate_playlist', { name: 'x', targetTrackCount: 1, candidateTrackUris: uris('zzz'), verifyCandidates: false });
    expect(unverified.json.preview).toHaveLength(1);
    expect(unverified.json.warnings.join(' ')).toMatch(/not verified/);
    expect(fake.requestsTo('GET', /^\/tracks\//)).toHaveLength(0);
  });

  it('aborts without mutating when a lookup fails for a reason other than "not found"', async () => {
    const fake = meFake().on('GET', /^\/tracks\//, { status: 403, body: { error: { status: 403, message: 'Forbidden' } } });
    session = await startSession(fake);
    const result = await session.call('generate_playlist', { name: 'x', candidateTrackUris: uris('k1'), dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Spotify API 403/);
    expect(fake.mutations).toHaveLength(0);
  });

  it('blocks creation when a same-name playlist exists', async () => {
    const fake = meFake()
      .on('GET', '/me/playlists', pagedRoute([playlistFixture('old', 'Gym', 'me-user')]))
      .on('GET', /^\/tracks\/\w+$/, ({ path }) => t(path.split('/').pop() ?? 'x'));
    session = await startSession(fake);
    const result = await session.call('generate_playlist', { name: 'Gym', targetTrackCount: 1, candidateTrackUris: uris('k1'), dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/already own 1 playlist/);
    expect(fake.mutations).toHaveLength(0);
  });

  it('reports created_with_errors when population fails after creation', async () => {
    const fake = meFake()
      .on('GET', '/me/playlists', pagedRoute([]))
      .on('GET', /^\/tracks\/\w+$/, ({ path }) => t(path.split('/').pop() ?? 'x'))
      .on('POST', '/me/playlists', playlistFixture('gen1', 'Oops', 'me-user'))
      .on('POST', '/playlists/gen1/items', { status: 500, body: { error: { status: 500, message: 'down' } } });
    session = await startSession(fake);

    const result = await session.call('generate_playlist', { name: 'Oops', targetTrackCount: 2, candidateTrackUris: uris('k1', 'k2'), dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.json.status).toBe('created_with_errors');
    expect(result.json.creation.playlist.id).toBe('gen1');
    expect(result.json.creation.population.failed.uris).toEqual(uris('k1', 'k2'));
    expect(fake.requestsTo('POST', '/me/playlists')).toHaveLength(1);
  });
});

describe('suggest_playlist_flow', () => {
  // A A A B B C — three adjacent artist repeats.
  const clustered = () => [t('1', 'A'), t('2', 'A'), t('3', 'A'), t('4', 'B'), t('5', 'B'), t('6', 'C')];
  const ids = (state: { items: TTrack[] }) => state.items.map((track) => track?.id);

  it('defaults to a preview with original and proposed order and no mutations', async () => {
    const fake = meFake();
    const state = statefulPlaylist(fake, 'pl1', clustered());
    session = await startSession(fake);

    const result = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'balanced_artists' });
    expect(result.json).toMatchObject({ status: 'preview', dryRun: true, strategy: 'balanced_artists', snapshotId: 'pl1-v0' });
    expect(result.json.originalOrder.map((entry: { uri: string }) => entry.uri)).toEqual(['1', '2', '3', '4', '5', '6'].map((id) => `spotify:track:${id}`));
    expect(result.json.proposedOrder.map((entry: { name: string }) => entry.name)).toEqual(['Song 1', 'Song 4', 'Song 6', 'Song 2', 'Song 5', 'Song 3']);
    expect(result.json.proposedOrder[1]).toMatchObject({ fromPosition: 3, artists: ['B'] });
    expect(result.json.changes).toMatchObject({
      adjacentSameArtistPairs: { before: 3, after: 0 },
      longestSameArtistRun: { before: 3, after: 1 },
    });
    expect(result.json.changes.reorderOperations).toBeGreaterThan(0);
    expect(fake.mutations).toHaveLength(0);
    expect(ids(state)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('applies the order with explicit dryRun: false and chains snapshots', async () => {
    const fake = meFake();
    const state = statefulPlaylist(fake, 'pl1', clustered());
    session = await startSession(fake);

    const preview = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'minimize_repetition' });
    const expectedOrder = preview.json.proposedOrder.map((entry: { uri: string }) => entry.uri.split(':')[2]);

    const result = await session.call('suggest_playlist_flow', {
      playlistId: 'pl1',
      strategy: 'minimize_repetition',
      dryRun: false,
      expectedSnapshotId: preview.json.snapshotId,
    });
    expect(result.isError).toBe(false);
    expect(result.json.status).toBe('applied');
    expect(ids(state)).toEqual(expectedOrder);
    expect(result.json.applied).toMatchObject({ removedItems: 0, reorderOperations: fake.mutations.length, of: fake.mutations.length });
    expect(fake.mutations.every((request) => request.method === 'PUT')).toBe(true);
    const snapshots = fake.mutations.map((request) => (request.body as { snapshot_id: string }).snapshot_id);
    expect(snapshots).toEqual(snapshots.map((_, index) => `pl1-v${index}`));
    expect(result.json.resultingSnapshotId).toBe(`pl1-v${fake.mutations.length}`);
  });

  it('reports no change when the order is already good', async () => {
    const fake = meFake();
    statefulPlaylist(fake, 'pl1', [t('1', 'A'), t('2', 'B'), t('3', 'C')]);
    session = await startSession(fake);
    const result = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'balanced_artists', dryRun: false });
    expect(result.json.status).toBe('no_change');
    expect(fake.mutations).toHaveLength(0);
  });

  it('rejects a stale snapshot before any change', async () => {
    const fake = meFake();
    const state = statefulPlaylist(fake, 'pl1', clustered());
    session = await startSession(fake);
    const result = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'balanced_artists', dryRun: false, expectedSnapshotId: 'old' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Playlist snapshot mismatch/);
    expect(fake.mutations).toHaveLength(0);
    expect(ids(state)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('never invents energy: subjective strategies ask for scores or an order', async () => {
    const fake = meFake();
    statefulPlaylist(fake, 'pl1', clustered());
    session = await startSession(fake);

    const result = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'gradual_build' });
    expect(result.json.status).toBe('needs_input');
    expect(result.json.reason).toMatch(/does not compute energy/);

    const custom = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'custom' });
    expect(custom.json.status).toBe('needs_input');
    expect(fake.mutations).toHaveLength(0);
  });

  it('applies caller-supplied scores', async () => {
    const fake = meFake();
    const state = statefulPlaylist(fake, 'pl1', [t('1', 'A'), t('2', 'B'), t('3', 'C'), t('4', 'D')]);
    session = await startSession(fake);
    const scores = { 'spotify:track:1': 8, 'spotify:track:2': 2, 'spotify:track:3': 5, 'spotify:track:4': 1 };

    const result = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'gradual_build', scores, dryRun: false });
    expect(result.json.status).toBe('applied');
    expect(ids(state)).toEqual(['4', '2', '3', '1']);
  });

  it('applies a custom proposed order and validates it first', async () => {
    const fake = meFake();
    const state = statefulPlaylist(fake, 'pl1', [t('1'), t('2'), t('3')]);
    session = await startSession(fake);

    const bad = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'custom', proposedOrder: ['spotify:track:3', 'spotify:track:1'], dryRun: false });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/every playlist item exactly once/);
    expect(fake.mutations).toHaveLength(0);

    const good = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'custom', proposedOrder: ['spotify:track:3', 'spotify:track:1', 'spotify:track:2'], dryRun: false });
    expect(good.json.status).toBe('applied');
    expect(ids(state)).toEqual(['3', '1', '2']);
  });

  it('preserves every item: exclusions need explicit confirmation before anything is removed', async () => {
    const fake = meFake();
    const state = statefulPlaylist(fake, 'pl1', clustered());
    session = await startSession(fake);
    const args = { playlistId: 'pl1', strategy: 'balanced_artists', excludeUris: ['spotify:track:3'] };

    const preview = await session.call('suggest_playlist_flow', args);
    expect(preview.json.excluded.map((entry: { uri: string }) => entry.uri)).toEqual(['spotify:track:3']);
    expect(preview.json.changes.removedItems).toBe(1);
    expect(preview.json.proposedOrder).toHaveLength(5);
    expect(preview.json.warnings.join(' ')).toMatch(/confirmRemoval/);

    const refused = await session.call('suggest_playlist_flow', { ...args, dryRun: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/pass confirmRemoval: true/);
    expect(fake.mutations).toHaveLength(0);

    const applied = await session.call('suggest_playlist_flow', { ...args, dryRun: false, confirmRemoval: true });
    expect(applied.json.status).toBe('applied');
    expect(applied.json.applied.removedItems).toBe(1);
    expect(fake.mutations[0]).toMatchObject({ method: 'DELETE', body: { items: [{ uri: 'spotify:track:3' }], snapshot_id: 'pl1-v0' } });
    expect(ids(state)).toHaveLength(5);
    expect(ids(state)).not.toContain('3');
    expect(ids(state)).toEqual(applied.json.proposedOrder.map((entry: { uri: string }) => entry.uri.split(':')[2]));
  });

  it('refuses to apply when unavailable items make positions ambiguous', async () => {
    const fake = meFake();
    statefulPlaylist(fake, 'pl1', [t('1', 'A'), null, t('2', 'A'), t('3', 'B')]);
    session = await startSession(fake);

    const preview = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'balanced_artists' });
    expect(preview.isError).toBe(false);
    expect(preview.json.warnings.join(' ')).toMatch(/unavailable item/);

    const apply = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'balanced_artists', dryRun: false });
    expect(apply.isError).toBe(true);
    expect(apply.text).toMatch(/unavailable items/);
    expect(fake.mutations).toHaveLength(0);
  });

  it('reports a partial failure with how far it got', async () => {
    const fake = meFake();
    statefulPlaylist(fake, 'pl1', clustered(), 'Playlist pl1', 2);
    session = await startSession(fake);

    const result = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'balanced_artists', dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.json.status).toBe('partial_failure');
    expect(result.json.applied.reorderOperations).toBe(1);
    expect(result.json.error).toMatch(/Spotify API 500/);
    expect(result.json.warnings.join(' ')).toMatch(/Re-read it/);
    expect(fake.requestsTo('PUT', '/playlists/pl1/items')).toHaveLength(2);
  });

  it('refuses plans that would need an unreasonable number of Spotify calls', async () => {
    const tracks = Array.from({ length: 450 }, (_, i) => t(`m${i}`, `Act ${i % 2}`));
    const reversed = tracks.map((track) => track?.uri ?? '').reverse();
    const fake = meFake();
    statefulPlaylist(fake, 'pl1', tracks);
    session = await startSession(fake);

    const result = await session.call('suggest_playlist_flow', { playlistId: 'pl1', strategy: 'custom', proposedOrder: reversed, dryRun: false });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/reorder operations \(limit 200\)/);
    expect(fake.mutations).toHaveLength(0);
  });
});
