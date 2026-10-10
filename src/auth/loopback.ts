import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EAuthErrorCode, type ILoopbackListener, type ILoopbackOptions } from '../models/auth.js';
import { AuthError } from './auth-error.js';

const LOOPBACK_HOST = '127.0.0.1';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Spotify Curator</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><p>${body}</p></body>`);
}

/**
 * Temporary callback listener bound to 127.0.0.1 only. Requests that are not a
 * valid callback for this attempt (wrong path/host/state) get an error page and
 * are ignored, so a stray local request cannot cancel a real sign-in.
 */
export async function startLoopbackListener(options: ILoopbackOptions): Promise<ILoopbackListener> {
  let settle: { resolve(code: string): void; reject(error: Error): void };
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The result may be rejected before a caller awaits it (e.g. abort during startup).
  result.catch(() => undefined);

  let port = options.port;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET' || request.headers.host !== `${LOOPBACK_HOST}:${port}`) {
      reply(response, 400, 'Unexpected request.');
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}:${port}`);
    } catch {
      reply(response, 400, 'Malformed request.');
      return;
    }
    if (url.pathname !== options.path) {
      reply(response, 404, 'Not found.');
      return;
    }
    const returnedState = url.searchParams.get('state');
    if (!returnedState || !safeEqual(returnedState, options.state)) {
      reply(response, 400, 'This sign-in link does not match the request Spotify Curator started. Please return to Spotify Curator Setup and try again.');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error) {
      reply(response, 200, 'Spotify access was not approved. You can close this tab and return to Spotify Curator Setup.');
      finish(() =>
        settle.reject(
          new AuthError(
            EAuthErrorCode.Cancelled,
            error === 'access_denied'
              ? 'Spotify authorization was cancelled. Choose "Connect Spotify" to try again.'
              : 'Spotify could not complete authorization. Check your Client ID and redirect URI, then try again.',
          ),
        ),
      );
      return;
    }
    if (!code) {
      reply(response, 400, 'Spotify did not return an authorization code. Please try again.');
      return;
    }
    reply(response, 200, 'Spotify is connected. You can close this tab and return to Spotify Curator Setup.');
    finish(() => settle.resolve(code));
  });

  let timer: NodeJS.Timeout | undefined;
  const onAbort = () =>
    finish(() => settle.reject(new AuthError(EAuthErrorCode.Cancelled, 'Spotify authorization was cancelled.')));

  function finish(action: () => void): void {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections();
    action();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new AuthError(
              EAuthErrorCode.PortInUse,
              `Port ${options.port} is already in use. Close the other program using it (or an earlier sign-in window) and try again.`,
            )
          : new AuthError(EAuthErrorCode.Unexpected, 'Could not start the local sign-in listener.'),
      );
    });
    server.listen(options.port, LOOPBACK_HOST, resolve);
  });
  port = (server.address() as { port: number }).port;

  timer = setTimeout(
    () =>
      finish(() =>
        settle.reject(
          new AuthError(
            EAuthErrorCode.Expired,
            'The Spotify sign-in timed out. If Spotify showed an error page, check your Client ID and that the redirect URI is registered exactly; then try again.',
          ),
        ),
      ),
    options.timeoutMs,
  );
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}${options.path}`,
    result,
    close: () => finish(() => undefined),
  };
}
