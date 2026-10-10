import { REQUESTED_SCOPES } from '../scopes.js';
import {
  EAuthErrorCode,
  EAuthState,
  type IAuthorizeOptions,
  type IAuthStatus,
  type IConnectedAccount,
  type IStoredCredentials,
  type ISpotifyAuthServiceDeps,
  type ITokenGrant,
  type ITokenProvider,
} from '../models/auth.js';
import type { ISpotifyTokenResponse } from '../models/spotify.js';
import { AuthError, NOT_CONNECTED_MESSAGE, REAUTHORIZE_MESSAGE } from './auth-error.js';
import { startLoopbackListener } from './loopback.js';
import { generatePkcePair, generateState } from './pkce.js';
import { redact } from './redact.js';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const ME_URL = 'https://api.spotify.com/v1/me';
export const DEFAULT_REDIRECT_PORT = 8888;
export const CALLBACK_PATH = '/callback';
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRY_SKEW_MS = 30_000;

/** Spotify client IDs are 32 hex characters. */
export function isPlausibleClientId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.trim());
}

/**
 * Authorization Code + PKCE (no client secret). Shared by the setup app and the
 * MCP runtime; the MCP process only needs the credential store, not the GUI.
 */
export class SpotifyAuthService implements ITokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly port: number;
  private cached: { grant: ITokenGrant; expiresAt: number } | null = null;
  private refreshing: Promise<ITokenGrant> | null = null;

  public constructor(private readonly deps: ISpotifyAuthServiceDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.port = deps.redirectPort ?? DEFAULT_REDIRECT_PORT;
  }

  public get redirectUri(): string {
    return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`;
  }

  // ---- Interactive authorization -----------------------------------------

  public async authorize(options: IAuthorizeOptions = {}): Promise<IConnectedAccount> {
    if (!isPlausibleClientId(this.deps.clientId)) {
      throw new AuthError(
        EAuthErrorCode.InvalidClientId,
        'That Client ID does not look right. It should be 32 letters and numbers, copied from your Spotify developer dashboard.',
      );
    }

    const { verifier, challenge } = generatePkcePair();
    const state = generateState();
    const listener = await startLoopbackListener({
      port: this.port,
      path: CALLBACK_PATH,
      state,
      timeoutMs: options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
      signal: options.signal,
    });

    try {
      const authorizeUrl = new URL(AUTHORIZE_URL);
      authorizeUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: this.deps.clientId.trim(),
        scope: REQUESTED_SCOPES.join(' '),
        redirect_uri: listener.redirectUri,
        state,
        code_challenge_method: 'S256',
        code_challenge: challenge,
      }).toString();

      options.onAuthorizeUrl?.(authorizeUrl.toString());
      try {
        await this.deps.openBrowser?.(authorizeUrl.toString());
      } catch {
        this.deps.log?.('Could not open the default browser; the sign-in link was shown instead.');
      }

      const code = await listener.result;
      const token = await this.exchangeCode(code, verifier, listener.redirectUri);
      const scopes = parseScopes(token.scope);
      const missing = REQUESTED_SCOPES.filter((scope) => !scopes.includes(scope));
      if (missing.length > 0) {
        throw new AuthError(
          EAuthErrorCode.MissingScopes,
          `Spotify did not grant all the permissions Spotify Curator needs (missing: ${missing.join(', ')}). Reconnect and approve every permission.`,
        );
      }
      if (!token.refresh_token) {
        throw new AuthError(
          EAuthErrorCode.Unexpected,
          'Spotify did not return a long-lived sign-in. Remove Spotify Curator from your Spotify account apps page and connect again.',
        );
      }

      const account = await this.fetchAccount(token.access_token);
      const credentials: IStoredCredentials = {
        refreshToken: token.refresh_token,
        scopes,
        obtainedAt: new Date().toISOString(),
        account,
      };
      await this.persist(credentials);
      this.cached = {
        grant: { accessToken: token.access_token, expiresInSeconds: token.expires_in, scopes },
        expiresAt: Date.now() + token.expires_in * 1000,
      };
      return account;
    } finally {
      listener.close();
    }
  }

  // ---- Runtime token access ---------------------------------------------

  public async getAccessToken(): Promise<ITokenGrant> {
    if (this.cached && Date.now() < this.cached.expiresAt - EXPIRY_SKEW_MS) {
      return this.cached.grant;
    }
    // Share one refresh between concurrent callers: a rotating refresh token is single-use.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  public async getStatus(): Promise<IAuthStatus> {
    if (!this.deps.clientId) return { state: EAuthState.NotConfigured };
    let credentials: IStoredCredentials | null;
    try {
      credentials = await this.deps.store.load();
    } catch (error) {
      return { state: EAuthState.Unreadable, detail: safeMessage(error) };
    }
    if (!credentials) return { state: EAuthState.NotConnected };
    return { state: EAuthState.Connected, account: credentials.account, scopes: credentials.scopes };
  }

  public async disconnect(): Promise<void> {
    this.cached = null;
    try {
      await this.deps.store.delete();
    } catch (error) {
      throw new AuthError(EAuthErrorCode.TokenStorageFailed, `Could not remove the saved Spotify sign-in: ${safeMessage(error)}`);
    }
  }

  /** Safe read-only call used by diagnostics and the connect step. */
  public async fetchAccount(accessToken: string): Promise<IConnectedAccount> {
    const response = await this.request(ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status === 403) {
      throw new AuthError(
        EAuthErrorCode.AccountNotAllowed,
        'Spotify refused access for this account. In Development Mode, add this Spotify account under "User management" in your app on the Spotify developer dashboard (the app owner needs Premium), then reconnect.',
      );
    }
    if (!response.ok) {
      throw new AuthError(EAuthErrorCode.Unexpected, `Spotify could not confirm your account (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as { id: string; display_name?: string | null };
    return { id: body.id, displayName: body.display_name ?? null };
  }

  // ---- Internals --------------------------------------------------------

  private async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<ISpotifyTokenResponse> {
    const response = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.deps.clientId.trim(),
        code_verifier: verifier,
      }),
    });
    if (!response.ok) throw await this.tokenError(response, false);
    return (await response.json()) as ISpotifyTokenResponse;
  }

  private async refresh(): Promise<ITokenGrant> {
    let credentials = await this.loadCredentials();
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
          client_id: this.deps.clientId.trim(),
        }),
      });

      if (!response.ok) {
        const error = await this.tokenError(response, true);
        if (attempt === 0 && error.code === EAuthErrorCode.ReauthorizationRequired) {
          // Another process (e.g. a second MCP client) may have rotated the token first.
          const latest = await this.loadCredentials();
          if (latest.refreshToken !== credentials.refreshToken) {
            credentials = latest;
            continue;
          }
        }
        throw error;
      }

      const token = (await response.json()) as ISpotifyTokenResponse;
      const scopes = token.scope ? parseScopes(token.scope) : credentials.scopes;
      if (token.refresh_token && token.refresh_token !== credentials.refreshToken) {
        try {
          await this.persist({ ...credentials, refreshToken: token.refresh_token, scopes });
        } catch {
          // This session still works; later sessions may need to reconnect.
          this.deps.log?.('Warning: Spotify rotated the sign-in but it could not be saved. You may need to reconnect.');
        }
      }
      const grant: ITokenGrant = { accessToken: token.access_token, expiresInSeconds: token.expires_in, scopes };
      this.cached = { grant, expiresAt: Date.now() + token.expires_in * 1000 };
      return grant;
    }
  }

  private async loadCredentials(): Promise<IStoredCredentials> {
    let credentials: IStoredCredentials | null;
    try {
      credentials = await this.deps.store.load();
    } catch (error) {
      throw new AuthError(
        EAuthErrorCode.CredentialsUnreadable,
        `The saved Spotify sign-in could not be read (${safeMessage(error)}). Open Spotify Curator Setup and reconnect Spotify.`,
      );
    }
    if (!credentials) throw new AuthError(EAuthErrorCode.NotConnected, NOT_CONNECTED_MESSAGE);
    return credentials;
  }

  private async persist(credentials: IStoredCredentials): Promise<void> {
    try {
      await this.deps.store.save(credentials);
    } catch (error) {
      throw new AuthError(
        EAuthErrorCode.TokenStorageFailed,
        `Spotify approved the connection, but Windows would not let Spotify Curator save it securely (${safeMessage(error)}). Nothing was connected; please try again.`,
      );
    }
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AuthError(EAuthErrorCode.Network, 'Could not reach Spotify. Check your internet connection and try again.');
    }
  }

  private async tokenError(response: Response, isRefresh: boolean): Promise<AuthError> {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'invalid_client') {
      return new AuthError(
        EAuthErrorCode.InvalidClientId,
        'Spotify does not recognize this Client ID. Copy it again from your app on the Spotify developer dashboard.',
      );
    }
    if (body.error === 'invalid_grant') {
      return new AuthError(
        isRefresh ? EAuthErrorCode.ReauthorizationRequired : EAuthErrorCode.Expired,
        isRefresh
          ? REAUTHORIZE_MESSAGE
          : 'Spotify rejected the sign-in (it may have expired or the redirect address does not match the one registered in your Spotify app). Try again.',
      );
    }
    return new AuthError(EAuthErrorCode.Unexpected, `Spotify sign-in failed (HTTP ${response.status}).`);
  }
}

function parseScopes(scope: string | undefined): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean);
}

function safeMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : 'unknown error');
}
