export enum EAuthErrorCode {
  InvalidClientId = 'invalid_client_id',
  Cancelled = 'cancelled',
  Expired = 'expired',
  PortInUse = 'port_in_use',
  MissingScopes = 'missing_scopes',
  AccountNotAllowed = 'account_not_allowed',
  NotConnected = 'not_connected',
  ReauthorizationRequired = 'reauthorization_required',
  TokenStorageFailed = 'token_storage_failed',
  CredentialsUnreadable = 'credentials_unreadable',
  Network = 'network',
  Unexpected = 'unexpected',
}

export enum ECredentialStoreErrorCode {
  Unsupported = 'unsupported',
  Corrupt = 'corrupt',
  Protection = 'protection',
  Io = 'io',
}

export enum EAuthState {
  NotConfigured = 'not_configured',
  NotConnected = 'not_connected',
  Connected = 'connected',
  Unreadable = 'unreadable',
}

export interface IPkcePair {
  verifier: string;
  challenge: string;
}

export interface IConnectedAccount {
  id: string;
  displayName: string | null;
}

/** Secret material persisted per Windows user. Never written to client config files. */
export interface IStoredCredentials {
  refreshToken: string;
  scopes: string[];
  obtainedAt: string;
  account?: IConnectedAccount;
}

export interface ICredentialStore {
  load(): Promise<IStoredCredentials | null>;
  save(credentials: IStoredCredentials): Promise<void>;
  delete(): Promise<void>;
}

/** Encrypts/decrypts a UTF-8 string for the current OS user (DPAPI on Windows). */
export interface ISecretProtector {
  protect(plaintext: string): Promise<string>;
  unprotect(protectedText: string): Promise<string>;
}

export interface ITokenGrant {
  accessToken: string;
  expiresInSeconds: number;
  /** Scopes Spotify reported for this grant, or null when unknown. */
  scopes: string[] | null;
}

export interface ITokenProvider {
  getAccessToken(): Promise<ITokenGrant>;
}

/** Non-secret settings shared by the setup app and the MCP runtime. */
export interface IAppSettings {
  clientId: string;
  redirectPort: number;
}

export interface IAuthStatus {
  state: EAuthState;
  account?: IConnectedAccount;
  scopes?: string[];
  /** Friendly reason when state is Unreadable. */
  detail?: string;
}

export interface IAuthorizeOptions {
  /** Called with the Spotify authorize URL, so a UI can show a fallback link. */
  onAuthorizeUrl?: (url: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ILoopbackOptions {
  port: number;
  path: string;
  state: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ILoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once a valid callback arrives. */
  result: Promise<string>;
  close(): void;
}

export interface ISpotifyAuthServiceDeps {
  clientId: string;
  redirectPort?: number;
  store: ICredentialStore;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
  /** Redacted diagnostics only; must never receive secrets. */
  log?: (message: string) => void;
}
