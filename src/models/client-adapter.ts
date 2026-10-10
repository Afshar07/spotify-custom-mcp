export enum EClientDetection {
  Installed = 'installed',
  NotFound = 'not_found',
  /** Cannot be determined reliably (e.g. no documented detection method). */
  Unknown = 'unknown',
}

/** How much of an integration has actually been verified against official docs and a real client. */
export enum EClientSupport {
  Supported = 'supported',
  Unverified = 'unverified',
  Unsupported = 'unsupported',
}

export enum EClientConflictPolicy {
  /** Refuse to install when another Spotify MCP entry exists. */
  Abort = 'abort',
  /** Set `enabled: false` on conflicting entries (reversible); never deletes them. */
  Disable = 'disable',
}

export interface IClientDetectionResult {
  installed: EClientDetection;
  support: EClientSupport;
  detail: string;
  configPath?: string;
}

export interface IClientConfiguration {
  configPath: string | null;
  configExists: boolean;
  /** False when the file cannot be parsed; the adapter will never rewrite such a file. */
  valid: boolean;
  /** Our entry exists in the client's config. */
  registered: boolean;
  /** Our entry launches the expected executable. */
  upToDate: boolean;
  command: string[] | null;
  conflicts: string[];
  problems: string[];
}

export interface IInstallOptions {
  executablePath: string;
  entryName?: string;
  conflictPolicy?: EClientConflictPolicy;
  /** Overrides config discovery (tests, or a user-chosen file). */
  configPath?: string;
}

export interface IInstallResult {
  changed: boolean;
  configPath: string;
  backupPath: string | null;
  disabledConflicts: string[];
}

export interface IVerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface IVerificationResult {
  ok: boolean;
  toolCount: number | null;
  checks: IVerificationCheck[];
}

export interface IMcpClientAdapter {
  id: string;
  name: string;
  support: EClientSupport;
  detect(): Promise<IClientDetectionResult>;
  inspect(): Promise<IClientConfiguration>;
  install(options: IInstallOptions): Promise<IInstallResult>;
  verify(): Promise<IVerificationResult>;
  uninstall(): Promise<void>;
}

export interface IMcpHandshakeResult {
  serverName: string;
  serverVersion: string;
  toolNames: string[];
}
