import { describe, expect, it } from 'vitest';
import { startLoopbackListener } from '../../src/auth/loopback.js';
import { EAuthErrorCode } from '../../src/models/auth.js';

const base = { port: 0, path: '/callback', state: 'good-state', timeoutMs: 5_000 };

describe('loopback callback listener', () => {
  it('resolves with the code for a valid callback', async () => {
    const listener = await startLoopbackListener(base);
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const response = await fetch(`${listener.redirectUri}?code=abc&state=good-state`);
    expect(response.status).toBe(200);
    await expect(listener.result).resolves.toBe('abc');
  });

  it('ignores a wrong state (400) and still accepts the real callback afterwards', async () => {
    const listener = await startLoopbackListener(base);
    expect((await fetch(`${listener.redirectUri}?code=evil&state=bad`)).status).toBe(400);
    expect((await fetch(`${listener.redirectUri}?code=evil`)).status).toBe(400);
    await fetch(`${listener.redirectUri}?code=real&state=good-state`);
    await expect(listener.result).resolves.toBe('real');
  });

  it('rejects malformed callbacks without a code and unknown paths', async () => {
    const listener = await startLoopbackListener(base);
    expect((await fetch(`${listener.redirectUri}?state=good-state`)).status).toBe(400);
    const other = listener.redirectUri.replace('/callback', '/other');
    expect((await fetch(other)).status).toBe(404);
    listener.close();
  });

  it('refuses requests whose Host header is not the loopback address (DNS rebinding)', async () => {
    const listener = await startLoopbackListener(base);
    const url = new URL(listener.redirectUri);
    const response = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port: url.port, path: '/callback?code=x&state=good-state', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.end();
      });
    });
    expect(response).toBe(400);
    listener.close();
  });

  it('reports cancelled authorization when Spotify returns access_denied', async () => {
    const listener = await startLoopbackListener(base);
    await fetch(`${listener.redirectUri}?error=access_denied&state=good-state`);
    await expect(listener.result).rejects.toMatchObject({ code: EAuthErrorCode.Cancelled });
  });

  it('expires after the timeout', async () => {
    const listener = await startLoopbackListener({ ...base, timeoutMs: 30 });
    await expect(listener.result).rejects.toMatchObject({ code: EAuthErrorCode.Expired });
  });

  it('cancels on abort', async () => {
    const controller = new AbortController();
    const listener = await startLoopbackListener({ ...base, signal: controller.signal });
    controller.abort();
    await expect(listener.result).rejects.toMatchObject({ code: EAuthErrorCode.Cancelled });
  });

  it('explains when the port is already in use', async () => {
    const first = await startLoopbackListener(base);
    const port = Number(new URL(first.redirectUri).port);
    await expect(startLoopbackListener({ ...base, port })).rejects.toMatchObject({ code: EAuthErrorCode.PortInUse });
    first.close();
  });
});
