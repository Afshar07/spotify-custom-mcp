import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AuthError } from '../auth/auth-error.js';
import { saveSettings } from '../auth/settings.js';
import { DEFAULT_REDIRECT_PORT, isPlausibleClientId, type SpotifyAuthService } from '../auth/spotify-auth-service.js';
import { runDiagnostics } from '../diagnostics.js';
import { ManualSetupRequiredError } from '../clients/chatgpt-adapter.js';
import { buildGenericStdioConfig } from '../clients/generic-config.js';
import { EAuthErrorCode, EAuthState, type IConnectedAccount } from '../models/auth.js';
import { EClientConflictPolicy } from '../models/client-adapter.js';
import type { AppContext } from './app-context.js';
import { SETUP_HTML } from './ui.js';

interface IConnectJob {
  state: 'idle' | 'running' | 'done' | 'error';
  authorizeUrl?: string;
  account?: IConnectedAccount;
  error?: { code: string; message: string };
}

export interface ISetupServer {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY = 16 * 1024;

/**
 * Local setup wizard backend. Loopback-only; every API call needs a per-run secret cookie,
 * a matching Host and (for writes) a matching Origin, so other web pages cannot drive it.
 */
export async function startSetupServer(app: AppContext, options: { port?: number; onShutdown?: () => void; onActivity?: () => void } = {}): Promise<ISetupServer> {
  const secret = randomBytes(24).toString('base64url');
  let job: IConnectJob = { state: 'idle' };
  let abort: AbortController | null = null;
  let port = 0;

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const authed = (request: IncomingMessage): boolean => {
    const cookie = /(?:^|;\s*)sc=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? '';
    return cookie.length === secret.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(secret));
  };
  const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error('Request too large.');
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  async function state() {
    const settings = await app.settings();
    const auth = settings ? app.authFor(settings) : null;
    const status = auth ? await auth.getStatus() : { state: EAuthState.NotConfigured };
    const [oc, ocConfig, gpt] = [await app.openCode.detect(), await app.openCode.inspect(undefined, [app.executablePath, 'mcp']), await app.chatGpt.detect()];
    return {
      version: app.version,
      redirectUri: `http://127.0.0.1:${settings?.redirectPort ?? DEFAULT_REDIRECT_PORT}/callback`,
      clientId: settings?.clientId ?? null,
      auth: status,
      clients: [
        { id: 'opencode', name: 'OpenCode', ...oc, registered: ocConfig.registered, upToDate: ocConfig.upToDate, conflicts: ocConfig.conflicts, problems: ocConfig.problems, valid: ocConfig.valid },
        { id: 'chatgpt-desktop', name: 'ChatGPT Desktop', ...gpt, manualSteps: app.chatGpt.manualSteps(app.executablePath) },
      ],
      genericConfig: buildGenericStdioConfig(app.executablePath),
    };
  }

  async function authOrThrow(): Promise<SpotifyAuthService> {
    const auth = await app.auth();
    if (!auth) throw new AuthError(EAuthErrorCode.NotConnected, 'Enter your Spotify Client ID first.');
    return auth;
  }

  async function route(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const method = request.method ?? 'GET';
    if (path === '/api/state' && method === 'GET') return json(response, 200, await state());
    if (path === '/api/job' && method === 'GET') return json(response, 200, job);
    if (path === '/api/generic-config' && method === 'GET') return json(response, 200, { config: buildGenericStdioConfig(app.executablePath) });

    if (method !== 'POST') return json(response, 404, { error: 'Not found' });
    const body = await readBody(request);

    switch (path) {
      case '/api/client-id': {
        const clientId = String(body.clientId ?? '').trim();
        if (!isPlausibleClientId(clientId)) {
          return json(response, 400, { error: 'That Client ID does not look right. It should be 32 letters and numbers, copied from your Spotify developer dashboard.' });
        }
        await saveSettings(app.dataDir, { clientId, redirectPort: DEFAULT_REDIRECT_PORT });
        return json(response, 200, { ok: true });
      }
      case '/api/connect': {
        if (job.state === 'running') return json(response, 409, { error: 'A sign-in is already in progress.' });
        const auth = await authOrThrow();
        abort = new AbortController();
        job = { state: 'running' };
        void auth
          .authorize({ signal: abort.signal, onAuthorizeUrl: (url) => (job = { ...job, authorizeUrl: url }) })
          .then((account) => (job = { state: 'done', account }))
          .catch((error: unknown) => {
            job = { state: 'error', error: { code: error instanceof AuthError ? error.code : 'unexpected', message: error instanceof AuthError ? error.message : 'Something went wrong while connecting to Spotify. Please try again.' } };
          });
        return json(response, 202, job);
      }
      case '/api/cancel':
        abort?.abort();
        return json(response, 200, { ok: true });
      case '/api/disconnect': {
        const auth = await app.auth();
        if (auth) await auth.disconnect();
        job = { state: 'idle' };
        return json(response, 200, { ok: true });
      }
      case '/api/install': {
        const clients = Array.isArray(body.clients) ? (body.clients as string[]) : [];
        const results: Record<string, unknown> = {};
        if (clients.includes('opencode')) {
          try {
            const install = await app.openCode.install({
              executablePath: app.executablePath,
              conflictPolicy: body.disableConflicts ? EClientConflictPolicy.Disable : EClientConflictPolicy.Abort,
            });
            // Success is only reported after the registered command really starts and lists tools.
            const verification = await app.openCode.verify();
            results.opencode = { installed: true, changed: install.changed, verified: verification.ok, toolCount: verification.toolCount, checks: verification.checks, disabledConflicts: install.disabledConflicts };
          } catch (error) {
            results.opencode = { installed: false, verified: false, message: (error as Error).message };
          }
        }
        if (clients.includes('chatgpt-desktop')) {
          try {
            await app.chatGpt.install({ executablePath: app.executablePath });
          } catch (error) {
            results['chatgpt-desktop'] = { installed: false, verified: false, manual: true, steps: error instanceof ManualSetupRequiredError ? error.steps : [], message: (error as Error).message };
          }
        }
        return json(response, 200, results);
      }
      case '/api/repair': {
        try {
          await app.openCode.install({ executablePath: app.executablePath, conflictPolicy: EClientConflictPolicy.Disable });
          return json(response, 200, { ok: true });
        } catch (error) {
          return json(response, 200, { ok: false, message: (error as Error).message });
        }
      }
      case '/api/diagnostics': {
        const settings = await app.settings();
        return json(response, 200, await runDiagnostics({
          executablePath: app.executablePath,
          hasClientId: !!settings,
          auth: settings ? app.authFor(settings) : null,
          handshake: app.handshake,
          openCode: app.openCode,
          chatGpt: app.chatGpt,
        }));
      }
      case '/api/shutdown':
        json(response, 200, { ok: true });
        setTimeout(() => options.onShutdown?.(), 50);
        return;
      default:
        return json(response, 404, { error: 'Not found' });
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        options.onActivity?.();
        if (request.headers.host !== `127.0.0.1:${port}`) return json(response, 400, { error: 'Bad host' });
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname === '/' && request.method === 'GET') {
          const supplied = url.searchParams.get('t') ?? '';
          const ok = supplied.length === secret.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
          if (!ok && !authed(request)) {
            response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Open Spotify Curator Setup from the Start menu.');
            return;
          }
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Set-Cookie': `sc=${secret}; HttpOnly; SameSite=Strict; Path=/`,
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
            'Referrer-Policy': 'no-referrer',
          });
          response.end(SETUP_HTML);
          return;
        }
        if (!url.pathname.startsWith('/api/') || !authed(request)) return json(response, 403, { error: 'Forbidden' });
        const origin = request.headers.origin;
        if (request.method === 'POST' && origin !== undefined && origin !== `http://127.0.0.1:${port}`) {
          return json(response, 403, { error: 'Forbidden' });
        }
        await route(request, response, url.pathname);
      } catch (error) {
        const message = error instanceof AuthError ? error.message : 'Something went wrong. Please try again.';
        if (!response.headersSent) json(response, error instanceof AuthError ? 400 : 500, { error: message });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/?t=${secret}`,
    close: () =>
      new Promise<void>((resolve) => {
        abort?.abort();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
