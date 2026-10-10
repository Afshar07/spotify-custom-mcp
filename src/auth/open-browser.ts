import { spawn } from 'node:child_process';

const ALLOWED_PREFIXES = ['https://accounts.spotify.com/', 'http://127.0.0.1:', 'https://developer.spotify.com/'];

/** Opens a URL in the default browser, without a shell. Only known-safe destinations are allowed. */
export async function openInDefaultBrowser(url: string): Promise<void> {
  if (!ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    throw new Error('Refusing to open an unexpected address.');
  }
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}
