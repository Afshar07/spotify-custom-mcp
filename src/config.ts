import 'dotenv/config';

export interface ISpotifyConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
}

export interface ISpotifyAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSpotifyConfig(): ISpotifyConfig {
  return {
    clientId: requireEnv('SPOTIFY_CLIENT_ID'),
    clientSecret: requireEnv('SPOTIFY_CLIENT_SECRET'),
    refreshToken: requireEnv('SPOTIFY_REFRESH_TOKEN'),
    redirectUri:
      process.env.SPOTIFY_REDIRECT_URI?.trim() ||
      'http://127.0.0.1:8888/callback',
  };
}

export function getSpotifyAuthConfig(): ISpotifyAuthConfig {
  return {
    clientId: requireEnv('SPOTIFY_CLIENT_ID'),
    clientSecret: requireEnv('SPOTIFY_CLIENT_SECRET'),
    redirectUri:
      process.env.SPOTIFY_REDIRECT_URI?.trim() ||
      'http://127.0.0.1:8888/callback',
  };
}
