import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openInDefaultBrowser } from './auth/open-browser.js';
import { runDiagnostics } from './diagnostics.js';
import { startMcpServer } from './mcp-main.js';
import { EClientConflictPolicy } from './models/client-adapter.js';
import { AppContext } from './setup/app-context.js';
import { startSetupServer } from './setup/setup-server.js';
import { APP_NAME, APP_VERSION } from './version.js';

const IDLE_EXIT_MS = 30 * 60_000;

const HELP = `${APP_NAME} ${APP_VERSION}

Usage: spotify-curator [command]

  (no command)          Open the setup wizard
  setup                 Open the setup wizard
  mcp                   Run the MCP server over stdio (used by AI apps)
  status [--json]       Show Spotify and integration status
  doctor [--json]       Run diagnostics
  connect               Connect Spotify from the command line
  disconnect            Remove the saved Spotify sign-in
  install-opencode      Register Spotify Curator in OpenCode (also repairs)
  install-chatgpt       Register Spotify Curator in ChatGPT Desktop (also repairs)
  cleanup [--opencode] [--chatgpt] [--credentials] [--settings]
                        Used by the uninstaller
  version
`;

function isSea(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command = 'setup', ...flags] = argv;
  const has = (flag: string): boolean => flags.includes(flag);

  if (command === 'mcp') {
    await startMcpServer(); // stdout is protocol-only from here on; nothing else may print.
    return -1; // keep running
  }
  if (command === 'version' || command === '--version') {
    process.stdout.write(`${APP_VERSION}\n`);
    return 0;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  const app = new AppContext();
  const print = (value: unknown, text: string): void => {
    process.stdout.write(has('--json') ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
  };

  switch (command) {
    case 'setup': {
      if (process.platform === 'win32' && !has('--foreground')) {
        // Detach so the console window closes right away.
        spawn(process.execPath, ['setup', '--foreground'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return 0;
      }
      let idle: NodeJS.Timeout;
      const server = await startSetupServer(app, {
        onShutdown: () => process.exit(0),
        onActivity: () => {
          clearTimeout(idle);
          idle = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
        },
      });
      idle = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
      await openInDefaultBrowser(server.url).catch(() => undefined);
      process.stderr.write(`Spotify Curator Setup is open in your browser: ${server.url.split('?')[0]}\n`);
      return -1;
    }
    case 'status': {
      const settings = await app.settings();
      const auth = settings ? await app.authFor(settings).getStatus() : { state: 'not_configured' };
      const oc = await app.openCode.inspect(undefined, [app.executablePath, 'mcp']);
      const gpt = await app.chatGpt.inspect();
      const report = { version: APP_VERSION, spotify: auth, opencode: { registered: oc.registered, upToDate: oc.upToDate, problems: oc.problems }, chatgpt: { registered: gpt.registered, upToDate: gpt.upToDate, problems: gpt.problems } };
      print(report, `Spotify: ${auth.state}\nOpenCode: ${oc.registered && oc.upToDate ? 'ready' : 'needs setup'}\nChatGPT Desktop: ${gpt.registered && gpt.upToDate ? 'configured (restart ChatGPT)' : 'needs setup'}`);
      return 0;
    }
    case 'doctor': {
      const settings = await app.settings();
      const report = await runDiagnostics({
        executablePath: app.executablePath, hasClientId: !!settings, auth: settings ? app.authFor(settings) : null,
        handshake: app.handshake, openCode: app.openCode, chatGpt: app.chatGpt,
      });
      print(report, report.checks.map((c) => `[${c.status.toUpperCase()}] ${c.title}: ${c.detail}`).join('\n'));
      return report.ok ? 0 : 1;
    }
    case 'connect': {
      const auth = await app.auth();
      if (!auth) {
        process.stderr.write('Enter your Spotify Client ID in the setup wizard first.\n');
        return 1;
      }
      const account = await auth.authorize({ onAuthorizeUrl: (url) => process.stderr.write(`If your browser did not open, visit:\n${url}\n`) });
      process.stdout.write(`Connected as ${account.displayName ?? account.id}\n`);
      return 0;
    }
    case 'disconnect':
      await (await app.auth())?.disconnect();
      process.stdout.write('Disconnected.\n');
      return 0;
    case 'install-opencode': {
      const result = await app.openCode.install({ executablePath: app.executablePath, conflictPolicy: has('--disable-conflicts') ? EClientConflictPolicy.Disable : EClientConflictPolicy.Abort });
      const verification = await app.openCode.verify();
      print({ ...result, verified: verification.ok, toolCount: verification.toolCount }, verification.ok ? `OpenCode is ready (${verification.toolCount} tools).` : 'OpenCode was updated but verification failed. Run "doctor".');
      return verification.ok ? 0 : 1;
    }
    case 'install-chatgpt': {
      const result = await app.chatGpt.install({ executablePath: app.executablePath,
        conflictPolicy: has('--disable-conflicts') ? EClientConflictPolicy.Disable : EClientConflictPolicy.Abort });
      const verification = await app.chatGpt.verify();
      print({ ...result, verified: verification.ok, toolCount: verification.toolCount }, verification.ok
        ? `ChatGPT Desktop is configured (${verification.toolCount} tools). Restart ChatGPT and use /mcp in a local chat.`
        : 'ChatGPT Desktop settings were updated but server startup failed. Run "doctor".');
      return verification.ok ? 0 : 1;
    }
    case 'cleanup': {
      let failed = false;
      async function clean(label: string, action: () => Promise<void>): Promise<void> {
        try { await action(); }
        catch {
          failed = true;
          process.stderr.write(`Could not remove ${label}. Remove it manually; other requested cleanup continues.\n`);
        }
      }
      if (has('--opencode')) await clean('the OpenCode entry', () => app.openCode.uninstall());
      if (has('--chatgpt')) await clean('the ChatGPT Desktop entry', () => app.chatGpt.uninstall());
      if (has('--credentials')) await clean('the saved Spotify sign-in', () => app.credentialStore().delete());
      if (has('--settings')) {
        await clean('Spotify Curator settings', () => rm(join(app.dataDir, 'settings.json'), { force: true }));
        await clean('Spotify Curator backups', () => rm(join(app.dataDir, 'backups'), { recursive: true, force: true }));
      }
      return failed ? 1 : 0;
    }
    default:
      process.stderr.write(HELP);
      return 2;
  }
}

if (isSea()) process.env.SPOTIFY_CURATOR_PACKAGED = '1';

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    // Never print raw errors here: they could embed request details.
    process.stderr.write(`Spotify Curator: ${error instanceof Error ? error.message.split('\n')[0] : 'unexpected error'}\n`);
    process.exitCode = 1;
  },
);
