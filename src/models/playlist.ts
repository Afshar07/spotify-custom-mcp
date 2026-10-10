import type { EGenerationRejection, EGenerationStatus } from './curation.js';

export interface ITrackPreview {
  uri: string;
  name: string;
  artists: string[];
}

export interface IPlaylistListEntry {
  id: string;
  name: string;
  description?: string;
  owner: string;
  ownerId?: string;
  isOwner?: boolean;
  public?: boolean | null;
  collaborative?: boolean;
  itemCount?: number;
  url?: string;
}

export interface ICreatePlaylistInput {
  name: string;
  description?: string;
  public: boolean;
  trackUris: string[];
  /** Create even if the user already owns a playlist with the same name. */
  allowDuplicateName: boolean;
}

export interface IPlaylistPopulation {
  requestedUris: string[];
  addedUris: string[];
  skippedDuplicateUris: string[];
  /** Present only when adding tracks failed after the playlist was created. */
  failed?: {
    uris: string[];
    error: string;
  };
}

export interface ICreatedPlaylist {
  id: string;
  name: string;
  public: boolean | null;
  url?: string;
  snapshotId?: string;
}

export interface ICreatePlaylistResult {
  dryRun: boolean;
  created: boolean;
  playlist?: ICreatedPlaylist;
  preview?: {
    name: string;
    description?: string;
    public: boolean;
  };
  population: IPlaylistPopulation;
  existingSameNamePlaylists?: IPlaylistListEntry[];
  warnings: string[];
}

export interface IGenerateRejectedEntry {
  uri: string;
  name?: string;
  reason: EGenerationRejection;
}

export interface IGenerationIntent {
  mood?: string;
  genres?: string[];
  artists?: string[];
  notes?: string;
}

export interface IGeneratePlaylistInput {
  name: string;
  description?: string;
  public: boolean;
  dryRun: boolean;
  targetTrackCount: number;
  candidateTrackUris: string[];
  seedPlaylistId?: string;
  excludeTrackUris: string[];
  excludeArtists: string[];
  maxTracksPerArtist?: number;
  verifyCandidates: boolean;
  allowPartial: boolean;
  allowDuplicateName: boolean;
  intent?: IGenerationIntent;
}

export interface IMoreCandidatesGuidance {
  missingCount: number;
  artistsAtLimit: string[];
  excludeUrisForNextSearch: string[];
  suggestedTools: string[];
  hint: string;
}

export interface IGeneratePlaylistResult {
  status: EGenerationStatus;
  dryRun: boolean;
  name: string;
  targetTrackCount: number;
  selectedCount: number;
  shortfall: number;
  preview: ITrackPreview[];
  rejectedByReason: Partial<Record<EGenerationRejection, number>>;
  rejected: IGenerateRejectedEntry[];
  /** Candidates left unchecked because the target was already reached. */
  notEvaluated: number;
  intent?: IGenerationIntent;
  needsMoreCandidates?: IMoreCandidatesGuidance;
  creation?: ICreatePlaylistResult;
  warnings: string[];
}
