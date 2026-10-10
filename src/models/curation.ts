export enum EPlaylistItemKind {
  Track = 'track',
  Episode = 'episode',
  Local = 'local',
}

export enum EPlaylistItemIssue {
  Unavailable = 'unavailable',
  LocalFile = 'local_file',
  Episode = 'episode',
  MissingArtists = 'missing_artists',
  MissingAlbum = 'missing_album',
  MissingReleaseDate = 'missing_release_date',
}

export enum EFlowStrategy {
  BalancedArtists = 'balanced_artists',
  MinimizeRepetition = 'minimize_repetition',
  GradualBuild = 'gradual_build',
  CalmStart = 'calm_start',
  StrongFinish = 'strong_finish',
  Custom = 'custom',
}

export enum EFlowStatus {
  Preview = 'preview',
  Applied = 'applied',
  NeedsInput = 'needs_input',
  NoChange = 'no_change',
}

export enum EGenerationRejection {
  Duplicate = 'duplicate',
  ExcludedTrack = 'excluded_track',
  ExcludedArtist = 'excluded_artist',
  NotFound = 'not_found',
  ArtistLimit = 'artist_limit',
  OverTarget = 'over_target',
}

export enum EGenerationStatus {
  Preview = 'preview',
  Created = 'created',
  CreatedWithErrors = 'created_with_errors',
  NeedsMoreCandidates = 'needs_more_candidates',
}

export interface INormalizedArtist {
  id?: string;
  name: string;
}

export interface INormalizedTrack {
  /** Zero-based position within the playlist (0 for non-playlist sources). */
  position: number;
  kind: EPlaylistItemKind;
  uri: string;
  /** Spotify track/episode ID; absent for local files. */
  id?: string;
  name: string;
  artists: INormalizedArtist[];
  albumId?: string;
  albumName?: string;
  releaseYear?: number;
  durationMs?: number;
  explicit?: boolean;
  url?: string;
}

export interface IPlaylistItemIssue {
  position: number;
  reason: EPlaylistItemIssue;
  uri?: string;
}

export interface INormalizedPlaylist {
  /** Items with usable metadata, in playlist order. */
  tracks: INormalizedTrack[];
  /** Positions that need attention (removed/unavailable, local, episodes, gaps). */
  issues: IPlaylistItemIssue[];
  /** Number of positions Spotify returned, including unavailable ones. */
  totalItems: number;
  /** Positions with no usable item (removed or unavailable). */
  unavailablePositions: number[];
}

// ---- Analysis ------------------------------------------------------------

export interface IArtistCount {
  id?: string;
  name: string;
  trackCount: number;
  share: number;
}

export interface IDuplicateTrack {
  uri: string;
  name: string;
  count: number;
  positions: number[];
}

export interface IAlbumCount {
  name: string;
  trackCount: number;
}

export interface IArtistConcentration {
  /** Share of artist-bearing tracks that feature the most represented artist. */
  topArtistShare: number;
  top3ArtistShare: number;
  /** Herfindahl–Hirschman index over each track's primary artist (0–1; 1 = one artist). */
  primaryArtistHhi: number;
  /** 1 / HHI: how many equally represented artists would give the same concentration. */
  effectiveArtistCount: number;
}

export interface IMissingMetadata {
  unavailableItems: number;
  localFiles: number;
  episodes: number;
  tracksMissingArtists: number;
  tracksMissingAlbum: number;
  tracksMissingReleaseDate: number;
}

export interface IPlaylistSuggestion {
  code: string;
  message: string;
}

export interface IExplicitDistribution {
  explicit: number;
  clean: number;
  unknown: number;
}

export interface IReleaseYearRange {
  oldest: number;
  newest: number;
}

export interface IPlaylistAnalysis {
  totalItems: number;
  uniqueTracks: number;
  duplicateItemCount: number;
  duplicates: IDuplicateTrack[];
  totalDurationMs: number;
  averageTrackDurationMs: number | null;
  uniqueArtists: number;
  topArtists: IArtistCount[];
  concentration: IArtistConcentration | null;
  uniqueAlbums: number;
  topAlbums: IAlbumCount[];
  releaseYears: Record<string, number>;
  releaseYearRange: IReleaseYearRange | null;
  explicit: IExplicitDistribution;
  missingMetadata: IMissingMetadata;
  suggestions: IPlaylistSuggestion[];
}

// ---- Comparison ----------------------------------------------------------

export interface ICompareOptions {
  maxListItems: number;
  includeMergeCandidates: boolean;
}

export interface ITrackRef {
  uri: string;
  name: string;
  artists: string[];
}

export interface ITruncatedList<TItem> {
  count: number;
  items: TItem[];
  truncated: boolean;
}

export interface IPlaylistSide {
  items: number;
  uniqueTracks: number;
  duplicateItems: number;
  nonTrackItems: number;
  totalDurationMs: number;
}

export interface IArtistOverlapEntry {
  name: string;
  tracksInA: number;
  tracksInB: number;
}

export interface IArtistOverlap {
  sharedArtists: number;
  uniqueArtistsA: number;
  uniqueArtistsB: number;
  artistJaccard: number;
  top: IArtistOverlapEntry[];
}

export interface IMergeCandidates {
  /** Tracks from B that A lacks. */
  intoA: ITruncatedList<ITrackRef>;
  /** Tracks from A that B lacks. */
  intoB: ITruncatedList<ITrackRef>;
}

export interface IPlaylistComparison {
  a: IPlaylistSide;
  b: IPlaylistSide;
  intersectionSize: number;
  unionSize: number;
  /** Jaccard similarity over unique Spotify track IDs: intersection / union. */
  similarity: number;
  shared: ITruncatedList<ITrackRef>;
  onlyInA: ITruncatedList<ITrackRef>;
  onlyInB: ITruncatedList<ITrackRef>;
  artistOverlap: IArtistOverlap;
  mergeCandidates?: IMergeCandidates;
  notes: string[];
}

// ---- Flow ----------------------------------------------------------------

export interface IFlowOptions {
  strategy: EFlowStrategy;
  /** Subjective scores keyed by URI; supplied by the caller, never computed. */
  scores?: Record<string, number>;
  /** Caller-proposed full ordering of URIs. */
  proposedOrder?: string[];
  excludeUris?: string[];
  /** Number of tracks treated as the "start"/"finish" for calm_start / strong_finish. */
  edgeCount: number;
}

export interface IFlowEntry {
  uri: string;
  name: string;
  artists: string[];
  fromPosition: number;
}

export interface IFlowMetrics {
  adjacentSameArtistPairs: number;
  longestSameArtistRun: number;
}

export interface IFlowPlan {
  order: IFlowEntry[];
  excluded: IFlowEntry[];
  before: IFlowMetrics;
  after: IFlowMetrics;
  movedItems: number;
}

export interface IFlowNeedsInput {
  needsInput: true;
  reason: string;
  missingScoreUris?: string[];
}

export interface IFlowMove {
  rangeStart: number;
  insertBefore: number;
}

// ---- Generation ----------------------------------------------------------

export interface IGenerationCandidate {
  track: INormalizedTrack;
  source: 'candidate' | 'seed';
}

export interface IGenerationRejection {
  uri: string;
  name?: string;
  reason: EGenerationRejection;
}

export interface IGenerationPlanOptions {
  targetTrackCount: number;
  excludeTrackUris: string[];
  excludeArtists: string[];
  maxTracksPerArtist?: number;
}

export interface IGenerationPlan {
  selected: INormalizedTrack[];
  rejected: IGenerationRejection[];
  rejectedByReason: Partial<Record<EGenerationRejection, number>>;
  shortfall: number;
  artistsAtLimit: string[];
}
