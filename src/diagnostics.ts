import { access } from 'node:fs/promises';
import { redact } from './auth/redact.js';
import type { SpotifyAuthService } from './auth/spotify-auth-service.js';
import { EAuthErrorCode, EAuthState } from './models/auth.js';
import { EClientSupport, type IMcpClientAdapter, type IMcpHandshakeResult } from './models/client-adapter.js';
import { EDiagnosticStatus, ERepairAction, type IDiagnosticCheck, type IDiagnosticsReport } from './models/diagnostics.js';
import { AuthError } from './auth/auth-error.js';

export interface IDiagnosticsDeps {
  executablePath: string;
  hasClientId: boolean;
  auth: SpotifyAuthService | null;
  handshake: (command: string[]) => Promise<IMcpHandshakeResult>;
  openCode: IMcpClientAdapter & { inspect(path?: string, expectedCommand?: string[]): ReturnType<IMcpClientAdapter['inspect']> };
  chatGpt: IMcpClientAdapter;
}

/** A sentinel tool every build must expose; guards against an empty or truncated tool list. */
const SENTINEL_TOOLS = ['search_tracks', 'generate_playlist'];

/**
 * Independent checks. A registered MCP entry is never taken as proof that Spotify works:
 * credentials, token refresh and a real read-only Spotify call are checked separately.
 */
export async function runDiagnostics(deps: IDiagnosticsDeps): Promise<IDiagnosticsReport> {
  const checks: IDiagnosticCheck[] = [];
  const add = (check: IDiagnosticCheck): IDiagnosticCheck => (checks.push(check), check);
  const skip = (id: string, title: string, why: string): void => void add({ id, title, status: EDiagnosticStatus.Skipped, detail: why });

  const exe = await fileExists(deps.executablePath);
  add({
    id: 'executable', title: 'Spotify Curator program files',
    status: exe ? EDiagnosticStatus.Pass : EDiagnosticStatus.Fail,
    detail: exe ? 'Found.' : 'The program file is missing. Reinstall Spotify Curator.',
    repair: exe ? undefined : ERepairAction.ReinstallApp,
  });

  // Credentials -> refresh -> real API call, each separate.
  let credentialsOk = false;
  if (!deps.hasClientId || !deps.auth) {
    add({ id: 'credentials', title: 'Saved Spotify sign-in', status: EDiagnosticStatus.Fail, detail: 'No Spotify Client ID has been entered yet.', repair: ERepairAction.EnterClientId });
  } else {
    const status = await deps.auth.getStatus();
    credentialsOk = status.state === EAuthState.Connected;
    add({
      id: 'credentials', title: 'Saved Spotify sign-in',
      status: credentialsOk ? EDiagnosticStatus.Pass : EDiagnosticStatus.Fail,
      detail: credentialsOk
        ? `Found${status.account?.displayName ? ` (${status.account.displayName})` : ''}.`
        : status.state === EAuthState.Unreadable
          ? `The saved sign-in cannot be read: ${status.detail ?? 'unknown reason'}. Reconnect Spotify.`
          : 'Spotify is not connected yet.',
      repair: credentialsOk ? undefined : ERepairAction.Reconnect,
    });
  }

  let accessToken: string | null = null;
  if (!credentialsOk || !deps.auth) {
    skip('refresh', 'Spotify access renewal', 'Skipped until Spotify is connected.');
    skip('spotify-api', 'Spotify responds', 'Skipped until Spotify is connected.');
  } else {
    try {
      accessToken = (await deps.auth.getAccessToken()).accessToken;
      add({ id: 'refresh', title: 'Spotify access renewal', status: EDiagnosticStatus.Pass, detail: 'Spotify accepted the saved sign-in.' });
    } catch (error) {
      add(failFromAuth('refresh', 'Spotify access renewal', error));
    }
    if (!accessToken) {
      skip('spotify-api', 'Spotify responds', 'Skipped because access could not be renewed.');
    } else {
      try {
        const account = await deps.auth.fetchAccount(accessToken);
        add({ id: 'spotify-api', title: 'Spotify responds', status: EDiagnosticStatus.Pass, detail: `Connected as ${account.displayName ?? account.id}.` });
      } catch (error) {
        add(failFromAuth('spotify-api', 'Spotify responds', error));
      }
    }
  }

  // MCP runtime, launched directly (not through any client's config).
  let toolCount: number | null = null;
  if (!exe) {
    skip('mcp-start', 'Spotify tools start', 'Skipped because the program is missing.');
    skip('mcp-tools', 'Spotify tools are available', 'Skipped because the program is missing.');
  } else {
    try {
      const result = await deps.handshake([deps.executablePath, 'mcp']);
      add({ id: 'mcp-start', title: 'Spotify tools start', status: EDiagnosticStatus.Pass, detail: `${result.serverName} ${result.serverVersion} started.` });
      const hasSentinels = SENTINEL_TOOLS.every((name) => result.toolNames.includes(name));
      toolCount = result.toolNames.length;
      add({
        id: 'mcp-tools', title: 'Spotify tools are available',
        status: hasSentinels ? EDiagnosticStatus.Pass : EDiagnosticStatus.Fail,
        detail: hasSentinels ? `${toolCount} tools found.` : 'Some expected tools are missing. Reinstall Spotify Curator.',
        repair: hasSentinels ? undefined : ERepairAction.ReinstallApp,
      });
    } catch (error) {
      add({ id: 'mcp-start', title: 'Spotify tools start', status: EDiagnosticStatus.Fail, detail: `The program did not start: ${redact((error as Error).message.split('\n')[0])}`, repair: ERepairAction.ReinstallApp });
      skip('mcp-tools', 'Spotify tools are available', 'Skipped because the program did not start.');
    }
  }

  // Clients.
  const oc = await deps.openCode.inspect(undefined, [deps.executablePath, 'mcp']);
  if (!oc.configExists || !oc.registered) {
    add({ id: 'opencode', title: 'OpenCode connection', status: EDiagnosticStatus.Fail, detail: oc.valid ? 'Spotify Curator is not set up in OpenCode.' : oc.problems.join(' '), repair: oc.valid ? ERepairAction.RepairOpenCode : undefined });
  } else if (!oc.valid || !oc.upToDate) {
    add({ id: 'opencode', title: 'OpenCode connection', status: EDiagnosticStatus.Fail, detail: oc.problems.join(' ') || 'OpenCode settings need repair.', repair: ERepairAction.RepairOpenCode });
  } else {
    add({ id: 'opencode', title: 'OpenCode connection', status: EDiagnosticStatus.Pass, detail: 'OpenCode is set up to use Spotify Curator.' });
  }

  if (deps.chatGpt.support === EClientSupport.Supported) {
    const result = await deps.chatGpt.verify();
    add({ id: 'chatgpt', title: 'ChatGPT Desktop connection', status: result.ok ? EDiagnosticStatus.Pass : EDiagnosticStatus.Fail, detail: result.checks.map((c) => c.detail).join(' ') });
  } else {
    skip('chatgpt', 'ChatGPT Desktop connection', 'Not checked: automatic ChatGPT Desktop setup is not verified yet.');
  }

  return { ok: checks.every((c) => c.status !== EDiagnosticStatus.Fail), toolCount, checks };
}

function failFromAuth(id: string, title: string, error: unknown): IDiagnosticCheck {
  const auth = error instanceof AuthError ? error : null;
  const needsReconnect = auth && [EAuthErrorCode.ReauthorizationRequired, EAuthErrorCode.NotConnected, EAuthErrorCode.CredentialsUnreadable].includes(auth.code);
  return {
    id, title, status: EDiagnosticStatus.Fail,
    detail: auth ? auth.message : redact(error instanceof Error ? error.message : 'Something went wrong.'),
    repair: needsReconnect ? ERepairAction.Reconnect : undefined,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
