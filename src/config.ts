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

function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSpotifyConfig(env: NodeJS.ProcessEnv = process.env): ISpotifyConfig {
  return {
    clientId: requireEnv('SPOTIFY_CLIENT_ID', env),
    clientSecret: requireEnv('SPOTIFY_CLIENT_SECRET', env),
    refreshToken: requireEnv('SPOTIFY_REFRESH_TOKEN', env),
    redirectUri:
      env.SPOTIFY_REDIRECT_URI?.trim() ||
      'http://127.0.0.1:8888/callback',
  };
}

/** Comma-separated tool names from SPOTIFY_DISABLED_TOOLS; those tools are not registered. */
export function getDisabledTools(): string[] {
  return (process.env.SPOTIFY_DISABLED_TOOLS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
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
