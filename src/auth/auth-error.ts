import { EAuthErrorCode } from '../models/auth.js';

/** Error whose message is already safe and friendly to show to a non-developer. */
export class AuthError extends Error {
  public constructor(
    public readonly code: EAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const NOT_CONNECTED_MESSAGE =
  'Spotify is not connected. Open Spotify Curator Setup and choose "Connect Spotify".';

export const REAUTHORIZE_MESSAGE =
  'Spotify no longer accepts the saved sign-in (it may have been revoked or expired). Open Spotify Curator Setup and reconnect Spotify.';
